#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <limits.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

extern int renameatx_np(int, const char *, int, const char *, unsigned int);
#ifndef RENAME_SWAP
#define RENAME_SWAP 0x00000002
#endif

static bool app_path(const char *path) {
  size_t length = strlen(path);
  return path[0] == '/' && length > 4 && strcmp(path + length - 4, ".app") == 0;
}

static int checked_lstat(const char *path, struct stat *info) {
  if (lstat(path, info) != 0) {
    perror(path);
    return -1;
  }
  if (S_ISLNK(info->st_mode)) {
    fprintf(stderr, "refusing symbolic link: %s\n", path);
    return -1;
  }
  return 0;
}

static bool caller_is_member(gid_t group) {
  if (getegid() == group) return true;
  int count = getgroups(0, NULL);
  if (count <= 0) return false;
  gid_t *groups = calloc((size_t)count, sizeof(*groups));
  if (!groups) return false;
  bool member = false;
  if (getgroups(count, groups) == count) {
    for (int index = 0; index < count; index++) {
      if (groups[index] == group) { member = true; break; }
    }
  }
  free(groups);
  return member;
}

static bool applications_parent(const char *path, const struct stat *info) {
  return strcmp(path, "/Applications") == 0 && info->st_uid == 0 && info->st_gid == 80 &&
      (info->st_mode & 0777) == 0775 && caller_is_member(80) && access(path, W_OK | X_OK) == 0;
}

static bool sticky_temp_parent(const char *path, const struct stat *info) {
  return (strcmp(path, "/tmp") == 0 || strcmp(path, "/private/tmp") == 0) &&
      info->st_uid == 0 && (info->st_mode & 0777) == 01777;
}

static bool protected_directory(const char *path, const struct stat *info) {
  if (!S_ISDIR(info->st_mode)) return false;
  if (info->st_uid != 0 && info->st_uid != geteuid()) return false;
  if ((info->st_mode & (S_IWGRP | S_IWOTH)) == 0) return true;
  return sticky_temp_parent(path, info) || applications_parent(path, info);
}

static bool owned_directory(const struct stat *info) {
  return S_ISDIR(info->st_mode) && info->st_uid == geteuid() &&
      (info->st_mode & (S_IWGRP | S_IWOTH)) == 0;
}

static bool namespace_alias(const char *path) {
  /* macOS owns these two root aliases.  Allowing no user-controlled alias
   * keeps the remaining ancestry checks meaningful. */
  return strcmp(path, "/var") == 0 || strcmp(path, "/tmp") == 0;
}

/* Every ancestor must be owned by us or root and must not be replaceable by
 * another user.  Root's sticky temporary directory is the sole safe shared
 * ancestor because its child names cannot be replaced by another account. */
static int safe_ancestry(const char *path) {
  char copy[PATH_MAX];
  if (strlcpy(copy, path, sizeof(copy)) >= sizeof(copy)) return -1;
  for (char *cursor = copy + 1; *cursor; cursor++) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    struct stat info;
    if (lstat(copy, &info) != 0) {
      perror(copy);
      return -1;
    }
    if (S_ISLNK(info.st_mode) && !namespace_alias(copy)) {
      fprintf(stderr, "unsafe path ancestry: %s\n", copy);
      return -1;
    }
    if (S_ISLNK(info.st_mode)) {
      if (stat(copy, &info) != 0 || !protected_directory(copy, &info)) {
        fprintf(stderr, "unsafe path ancestry: %s\n", copy);
        return -1;
      }
    } else if (!protected_directory(copy, &info)) {
      fprintf(stderr, "unsafe path ancestry: %s\n", copy);
      return -1;
    }
    *cursor = '/';
  }
  return 0;
}

static int checked_bundle(int parent_fd, const char *name, struct stat *bundle_info) {
  if (fstatat(parent_fd, name, bundle_info, AT_SYMLINK_NOFOLLOW) != 0 ||
      S_ISLNK(bundle_info->st_mode) || !owned_directory(bundle_info)) return -1;
  int bundle_fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (bundle_fd < 0) return -1;
  struct stat contents, macos;
  int valid = fstatat(bundle_fd, "Contents", &contents, AT_SYMLINK_NOFOLLOW) == 0 &&
      !S_ISLNK(contents.st_mode) && owned_directory(&contents) &&
      fstatat(bundle_fd, "Contents/MacOS", &macos, AT_SYMLINK_NOFOLLOW) == 0 &&
      !S_ISLNK(macos.st_mode) && owned_directory(&macos);
  close(bundle_fd);
  return valid ? 0 : -1;
}

int main(int argc, char *argv[]) {
  if (argc != 3) {
    fprintf(stderr, "usage: GatewayUpdateInstaller /absolute/Target.app /absolute/Stage.app\n");
    return 64;
  }
  const char *target = argv[1];
  const char *stage = argv[2];
  if (!app_path(target) || !app_path(stage) || safe_ancestry(target) != 0 ||
      safe_ancestry(stage) != 0) {
    fprintf(stderr, "target and stage must be absolute .app paths with safe ancestry\n");
    return 65;
  }

  struct stat target_path, stage_path;
  if (checked_lstat(target, &target_path) != 0 || checked_lstat(stage, &stage_path) != 0) {
    return 65;
  }
  char target_real[PATH_MAX], stage_real[PATH_MAX], target_copy[PATH_MAX], stage_copy[PATH_MAX];
  if (!realpath(target, target_real) || !realpath(stage, stage_real) ||
      strlcpy(target_copy, target_real, sizeof(target_copy)) >= sizeof(target_copy) ||
      strlcpy(stage_copy, stage_real, sizeof(stage_copy)) >= sizeof(stage_copy)) {
    fprintf(stderr, "path is too long\n");
    return 65;
  }
  char *target_parent = dirname(target_copy);
  char *stage_parent = dirname(stage_copy);
  char target_name[NAME_MAX + 1], stage_name[NAME_MAX + 1];
  if (strlcpy(target_name, basename(target_real), sizeof(target_name)) >= sizeof(target_name) ||
      strlcpy(stage_name, basename(stage_real), sizeof(stage_name)) >= sizeof(stage_name) ||
      strcmp(target_parent, stage_parent) != 0) {
    fprintf(stderr, "target and stage must be siblings\n");
    return 65;
  }

  int parent_fd = open(target_parent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  struct stat parent, target_info, stage_info;
  if (parent_fd < 0 || fstat(parent_fd, &parent) != 0 ||
      (!owned_directory(&parent) && !applications_parent(target_parent, &parent))) {
    if (parent_fd >= 0) close(parent_fd);
    fprintf(stderr, "parent is not an owned protected directory\n");
    return 65;
  }
  if (checked_bundle(parent_fd, target_name, &target_info) != 0 ||
      checked_bundle(parent_fd, stage_name, &stage_info) != 0 ||
      (target_info.st_dev == stage_info.st_dev && target_info.st_ino == stage_info.st_ino)) {
    close(parent_fd);
    fprintf(stderr, "target and stage must be distinct app directories\n");
    return 65;
  }

  if (renameatx_np(parent_fd, target_name, parent_fd, stage_name, RENAME_SWAP) != 0) {
    close(parent_fd);
    perror("atomic app swap");
    return 74;
  }
  close(parent_fd);
  return 0;
}
