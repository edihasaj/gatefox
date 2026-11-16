#include <Security/Security.h>
#include <Security/AuthSession.h>
#include <pwd.h>
#include <sys/sysctl.h>

/* No credential reads or password buffers: SecurityAgent owns the unlock dialog. */
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static int login_keychain(int unlock) {
    struct passwd *user = getpwuid(getuid());
    char path[4096];
    SecKeychainRef keychain = NULL;
    SecKeychainStatus status = 0;
    SecuritySessionId session = 0;
    SessionAttributeBits attributes = 0;
    char boot[64] = {0};
    size_t boot_size = sizeof(boot);
    const char *state = "unknown";
    int graphic = SessionGetInfo(callerSecuritySession, &session, &attributes) == errSecSuccess &&
        (attributes & sessionHasGraphicAccess) != 0;
    if (sysctlbyname("kern.bootsessionuuid", boot, &boot_size, NULL, 0) != 0) boot[0] = '\0';
    /* Only a UUID is allowed into the fixed status envelope. */
    for (size_t i = 0; i < sizeof(boot) && boot[i]; i++) {
        if (!((boot[i] >= 'a' && boot[i] <= 'f') || (boot[i] >= 'A' && boot[i] <= 'F') ||
              (boot[i] >= '0' && boot[i] <= '9') || boot[i] == '-')) { boot[0] = '\0'; break; }
    }
    boot[sizeof(boot) - 1] = '\0';
    if (user != NULL && snprintf(path, sizeof(path), "%s/Library/Keychains/login.keychain-db", user->pw_dir) < (int)sizeof(path) &&
        SecKeychainOpen(path, &keychain) == errSecSuccess &&
        SecKeychainGetStatus(keychain, &status) == errSecSuccess) {
        state = (status & kSecUnlockStateStatus) ? "unlocked" : "locked";
        if (unlock && graphic && !(status & kSecUnlockStateStatus)) {
            OSStatus result = SecKeychainUnlock(keychain, 0, NULL, false);
            if (result == errSecUserCanceled) state = "cancelled";
            else if (result == errSecSuccess && SecKeychainGetStatus(keychain, &status) == errSecSuccess &&
                     (status & kSecUnlockStateStatus)) state = "unlocked";
            else state = "failed";
        }
    }
    if (keychain != NULL) CFRelease(keychain);
    printf("{\"state\":\"%s\",\"graphic\":%s,\"session\":%u,\"boot\":\"%s\"}\n",
           state, graphic ? "true" : "false", (unsigned int)session, boot);
    return 0;
}
#pragma clang diagnostic pop
