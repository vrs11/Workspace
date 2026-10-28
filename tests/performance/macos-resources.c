// Local profiling helper, never bundled with the application.
// Coalition ABI reference (Apple XNU): bsd/sys/proc_info_private.h and
// osfmk/mach/coalition.h. Only the constant/layout is declared here; no private
// Apple header or implementation is copied. Unsupported queries fail closed.
#include <libproc.h>
#include <sys/resource.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

struct coalition_ids { uint64_t resource, jetsam, reserved[3]; };
static uint64_t coalition(int pid) {
    struct coalition_ids ids = {0};
    return proc_pidinfo(pid, 20, 0, &ids, sizeof(ids)) == sizeof(ids) ? ids.resource : 0;
}
int main(int argc, char **argv) {
    if (argc != 2) return 2;
    int app = atoi(argv[1]);
    uint64_t id = coalition(app);
    if (app <= 1 || !id || id == coalition(getpid())) {
        fprintf(stderr, "App resource coalition is unavailable or not isolated; launch the app through LaunchServices.\n");
        return 3;
    }
    int capacity = proc_listallpids(NULL, 0) + 1024;
    if (capacity <= 1024 || capacity > 1000000) return 4;
    int *pids = calloc((size_t)capacity, sizeof(int));
    if (!pids) return 5;
    int count = proc_listallpids(pids, capacity * sizeof(int));
    int first = 1, found_app = 0, found_webview = 0, failures = 0;
    uint64_t resident = 0, footprint = 0, cpu = 0;
    printf("{\"coalition\":%llu,\"members\":[", (unsigned long long)id);
    for (int i = 0; i < count && i < capacity; i++) {
        int pid = pids[i];
        if (pid <= 1 || coalition(pid) != id) continue;
        struct rusage_info_v4 usage = {0};
        char name[256] = {0};
        if (proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&usage) || proc_name(pid, name, sizeof(name)) <= 0) {
            failures++;
            continue;
        }
        // Classify using only process names; never inspect argv or environment.
        const char *role = pid == app ? "application" : strstr(name, "WebKit") ? "webview" : "other-coalition-member";
        found_app |= pid == app;
        found_webview |= strcmp(role, "webview") == 0;
        if (!first) printf(",");
        first = 0;
        uint64_t process_cpu = usage.ri_user_time + usage.ri_system_time;
        printf("{\"pid\":%d,\"role\":\"%s\",\"startAbstime\":%llu,\"residentBytes\":%llu,\"footprintBytes\":%llu,\"cpuNs\":%llu}",
            pid, role, (unsigned long long)usage.ri_proc_start_abstime,
            (unsigned long long)usage.ri_resident_size, (unsigned long long)usage.ri_phys_footprint,
            (unsigned long long)process_cpu);
        resident += usage.ri_resident_size; footprint += usage.ri_phys_footprint; cpu += process_cpu;
    }
    free(pids);
    printf("],\"residentBytes\":%llu,\"footprintBytes\":%llu,\"cpuNs\":%llu,\"queryFailures\":%d,\"hasApp\":%s,\"hasWebview\":%s}\n",
        (unsigned long long)resident, (unsigned long long)footprint, (unsigned long long)cpu,
        failures, found_app ? "true" : "false", found_webview ? "true" : "false");
    return found_app && found_webview && !failures ? 0 : 6;
}
