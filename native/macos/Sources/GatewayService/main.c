#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

enum {
    maximum_launcher_size = 64 * 1024,
    launcher_failure_exit = 78,
    path_size = 4096,
};

/* GateFox installers write the first marker; installations from before 1.8.0 carry the second. */
static const char *const installer_markers[] = {
    "# Managed by gatefox installer",
    "# Managed by subscription-gateway installer",
};
static const char failure_message[] = "Gateway service launcher failed\n";
static const char service_suffix[] = "/Contents/MacOS/GatewayService";
static const char runtime_suffix[] = "/Contents/Resources/backend/runtime/bin/node";
/* A fresh installation lives in share/gatefox; one from before 1.8.0 keeps share/subscription-gateway. */
static const char *const cli_suffixes[] = {
    "/share/gatefox/current/package/dist/cli.js",
    "/share/subscription-gateway/current/package/dist/cli.js",
};
static const char *const command_names[] = {
    "gateway", "gatefox", "harness-gateway", "subscription-gateway",
};

static void fail(void) {
    size_t written = 0;
    const size_t length = sizeof(failure_message) - 1;

    while (written < length) {
        ssize_t result = write(STDERR_FILENO, failure_message + written, length - written);
        if (result > 0) {
            written += (size_t)result;
        } else if (result < 0 && errno != EINTR) {
            break;
        }
    }
    _exit(launcher_failure_exit);
}

static int close_descriptor(int descriptor) {
    int result;

    do {
        result = close(descriptor);
    } while (result < 0 && errno == EINTR);
    return result;
}

static int is_expected_mode(const char *mode) {
    return strcmp(mode, "daemon") == 0 || strcmp(mode, "serve") == 0;
}

static int has_installer_marker(const char *contents, size_t length) {
    size_t line_start = 0;

    for (size_t index = 0; index <= length; index++) {
        if (index != length && contents[index] != '\n') {
            continue;
        }
        for (size_t marker = 0; marker < sizeof(installer_markers) / sizeof(installer_markers[0]); marker++) {
            size_t marker_length = strlen(installer_markers[marker]);
            if (index - line_start == marker_length &&
                memcmp(contents + line_start, installer_markers[marker], marker_length) == 0) {
                return 1;
            }
        }
        line_start = index + 1;
    }
    return 0;
}

static int validate_launcher(const char *path) {
    char contents[maximum_launcher_size];
    struct stat status;
    size_t length = 0;
    int descriptor;

    descriptor = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
        return 0;
    }
    if (fstat(descriptor, &status) != 0 || !S_ISREG(status.st_mode) ||
        status.st_uid != getuid() || (status.st_mode & S_IXUSR) == 0 || status.st_size < 0 ||
        status.st_size > maximum_launcher_size ||
        (status.st_mode & (S_IWGRP | S_IWOTH)) != 0) {
        (void)close_descriptor(descriptor);
        return 0;
    }

    for (;;) {
        ssize_t result;

        if (length == sizeof(contents)) {
            char extra;
            result = read(descriptor, &extra, sizeof(extra));
            if (result != 0) {
                (void)close_descriptor(descriptor);
                return 0;
            }
            break;
        }
        result = read(descriptor, contents + length, sizeof(contents) - length);
        if (result > 0) {
            length += (size_t)result;
        } else if (result == 0) {
            break;
        } else if (errno != EINTR) {
            (void)close_descriptor(descriptor);
            return 0;
        }
    }

    if (length != (size_t)status.st_size || close_descriptor(descriptor) != 0) {
        return 0;
    }
    return has_installer_marker(contents, length);
}

static int check_file(const char *path, int needs_execute) {
    struct stat status;

    int descriptor = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (descriptor < 0) {
        return 0;
    }
    int ok = fstat(descriptor, &status) == 0 && S_ISREG(status.st_mode) &&
        (status.st_uid == getuid() || status.st_uid == 0) &&
        (status.st_mode & (S_IWGRP | S_IWOTH)) == 0 &&
        (!needs_execute || (status.st_mode & S_IXUSR) != 0);
    (void)close_descriptor(descriptor);
    return ok;
}

static int split_command(const char *command, char *prefix) {
    if (command[0] != '/') {
        return 0;
    }
    const char *slash = strrchr(command, '/');
    if (slash == NULL || slash - command < 4 || memcmp(slash - 4, "/bin", 4) != 0 ||
        slash[1] == '\0') {
        return 0;
    }
    int matched = 0;
    for (size_t index = 0; index < sizeof(command_names) / sizeof(command_names[0]); index++) {
        if (strcmp(slash + 1, command_names[index]) == 0) {
            matched = 1;
            break;
        }
    }
    size_t prefix_length = (size_t)(slash - command) - 4;
    if (!matched || prefix_length == 0 || prefix_length >= path_size) {
        return 0;
    }
    memcpy(prefix, command, prefix_length);
    prefix[prefix_length] = '\0';
    return 1;
}

static int resolve_service_root(char *root) {
    char raw[path_size];
    char real[path_size];
    uint32_t size = sizeof(raw);

    if (_NSGetExecutablePath(raw, &size) != 0) {
        return 0;
    }
    if (realpath(raw, real) == NULL) {
        return 0;
    }
    size_t length = strlen(real);
    size_t suffix_length = sizeof(service_suffix) - 1;
    if (length <= suffix_length || strcmp(real + length - suffix_length, service_suffix) != 0) {
        return 0;
    }
    memcpy(root, real, length - suffix_length);
    root[length - suffix_length] = '\0';
    return 1;
}

static int select_tool_runtime(const char *node) {
    const char *slash = strrchr(node, '/');
    const char *previous = getenv("PATH");
    if (previous == NULL) {
        previous = "/usr/bin:/bin:/usr/sbin:/sbin";
    }
    size_t directory_length = (size_t)(slash - node);
    size_t previous_length = previous == NULL ? 0 : strlen(previous);
    char *path = malloc(directory_length + previous_length + 2);
    if (path == NULL) {
        return 0;
    }
    memcpy(path, node, directory_length);
    path[directory_length] = '\0';
    if (previous_length > 0) {
        path[directory_length] = ':';
        memcpy(path + directory_length + 1, previous, previous_length + 1);
    }
    int result = setenv("PATH", path, 1) == 0;
    free(path);
    return result;
}

int main(int argc, char *argv[]) {
    if (argc < 2 || !is_expected_mode(argv[1]) || !validate_launcher(argv[0])) {
        fail();
    }

    char prefix[path_size];
    if (!split_command(argv[0], prefix)) {
        fail();
    }

    char root[path_size];
    if (!resolve_service_root(root)) {
        fail();
    }

    char node[path_size];
    char cli[path_size];
    if (snprintf(node, sizeof(node), "%s%s", root, runtime_suffix) >= (int)sizeof(node) ||
        !check_file(node, 1)) {
        fail();
    }
    int found = 0;
    for (size_t index = 0; !found && index < sizeof(cli_suffixes) / sizeof(cli_suffixes[0]); index++) {
        found = snprintf(cli, sizeof(cli), "%s%s", prefix, cli_suffixes[index]) < (int)sizeof(cli) &&
            check_file(cli, 0);
    }
    if (!found) {
        fail();
    }

    char **child = calloc((size_t)argc + 2, sizeof(*child));
    if (child == NULL) {
        fail();
    }
    child[0] = node;
    child[1] = cli;
    for (int index = 1; index < argc; index++) {
        child[index + 1] = argv[index];
    }
    child[argc + 1] = NULL;

    if (setenv("GATEWAY_COMMAND", argv[0], 1) != 0 ||
        setenv("GATEWAY_INSTALLED", "1", 1) != 0 || !select_tool_runtime(node)) {
        fail();
    }

    execv(node, child);
    fail();
}
