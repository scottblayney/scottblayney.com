I run a four-node k3s cluster at home. I upgraded one worker from Ubuntu 24.04 to 26.04, and over the next two weeks two different Postgres databases hung on it. Both times the data was fine. A blocked signal was the problem, and the only evidence was a line in the node's kernel log.

A note on how I worked. I used Claude Code for both investigations: it ran the read-only `kubectl` and log checks, wrote the fix as a pull request, and helped me write this post. I reviewed and merged the change, and I ran the recovery steps (deleting the pod, scaling Immich back up). Where something below is inferred and not confirmed, I say so, and there's a list at the end.

## TL;DR

- On Ubuntu 26.04, containerd runs containers under a *stacked* AppArmor profile, and its default profile doesn't allow signals to the stacked peer.
- Postgres uses `SIGURG` to wake its own processes. When that signal is denied, some waits never end. Nothing crashes and nothing logs an error.
- The fix that worked for me is `appArmorProfile: Unconfined` on the database container. It's a workaround, not a cure.
- A fix has been merged into containerd's main branch, but it isn't in any release yet, so I'm keeping the workaround.

## The setup

- k3s, four nodes, managed with Flux
- Rook-Ceph for shared storage
- Nextcloud All-in-One, whose database is a Postgres 18 container
- Immich, whose database is a CloudNativePG cluster with a single instance
- Two nodes on 26.04 (kernel 7.0): the control-plane node and the worker I upgraded. The other two workers were still on 24.04 (kernel 6.8), which turned out to be a useful control.

## Incident 1: the Nextcloud database that never became ready

After the upgrade, the Postgres pod behind Nextcloud never became ready. I spent a few hours on the wrong things:

1. **A stale volume attachment.** The pod first complained that its volume was already attached to another node. That cleared up on its own.
2. **A scary log.** `database system was interrupted while in recovery`, with a hint that the data might be corrupted. The hint is generic. The `invalid record length ... got 0` line just marks the end of the WAL, and the last checkpoint was a few bytes from the end, so recovery should have taken milliseconds.
3. **Slow storage.** A write test with fsync showed about 32 MB/s. Ceph was `HEALTH_OK` with every placement group active and clean.
4. **Liveness probes.** The probe really was killing the container every 90 seconds. A startup probe stopped the restarts, but then the pod sat "starting up" for ten minutes. So probes made a different problem worse. They didn't cause it.

Two things finally pointed the right way. First, the Postgres processes were all asleep (`S` in `ps`, not `D`) with almost no CPU time. `D` means stuck on I/O. `S` means waiting on another process. Second, the container's shutdown handler logged `pg_ctl: could not send stop signal ... Permission denied`. That is the same user signalling its own process, which file permissions can't explain. It's a Linux Security Module.

So I read the node's kernel log:

```
apparmor="DENIED" operation="signal" class="signal"
profile="cri-containerd.apparmor.d" comm="postgres"
requested_mask="send" signal=urg
peer="cri-containerd.apparmor.d//&unconfined"
```

## What that line says

- `signal=urg`: Postgres uses `SIGURG` for latch wakeups between its processes. At the end of recovery, the startup process asks the checkpointer to run a checkpoint and waits for the wakeup.
- `//&unconfined`: the receiving process carries a *stacked* AppArmor label. containerd's default profile only allows signals to the plain `cri-containerd.apparmor.d` peer, so the stacked label doesn't match and the signal is denied.

The checkpointer never woke up and neither did the startup process. Nothing crashed. The only trace was in the kernel audit log.

## The first fix

```yaml
containers:
  - name: nextcloud-aio-database
    securityContext:
      appArmorProfile:
        type: Unconfined
    startupProbe:
      exec: { command: ["/healthcheck.sh"] }
      periodSeconds: 30
      timeoutSeconds: 30
      failureThreshold: 60
```

The pod came up in seconds. The chart has no securityContext values, so I made it permanent by putting the Helm release under Flux with a `postRenderers` patch.

## Incident 2: Immich, eleven days later

An automated k3s upgrade (the Rancher system-upgrade-controller) restarted the k3s agent on the same worker. The Immich database container restarted 21 seconds later. Soon after, Immich started crash-looping with a different error:

```
PostgresError: sorry, too many clients already
```

The first instinct is to blame Immich's connection pool. That would have been wrong. I couldn't even connect as the superuser, and `psql` failed with the same error, so I looked at the Postgres processes from outside with `kubectl exec ... ps`. Postgres sets each backend's process title, and there were exactly **100 of them**, all like this:

```
postgres: <cluster>: postgres postgres [local] authentication
```

100 is the default `max_connections`. They were asleep, using no CPU, and each one was waiting on something that never came. They were local logins arriving every ten seconds, which looks like the operator's own health checks, though I didn't prove that. The operator couldn't get a status either (`Instance Status Extraction Error: HTTP communication issue`), and because the stuck logins were superuser logins, they used up the reserved superuser slots too.

The same kernel line was in the log, this time with `comm="postgres"`, repeated about 28,000 times over three days. That's roughly one every ten seconds, which matches the health-check rate.

### A counterintuitive detail

The same kind of denial had been in the log for five healthy days before this. So counting denials doesn't tell you whether Postgres is broken. My reading, which I haven't proven, is that most waits have a timeout fallback, and the ones that hurt are the waits with none, like the end of crash recovery. The process list agrees: the checkpointer and background writer started right away, but the write-ahead-log writer and archiver started **5 minutes 10 seconds later**. That is a database that sat in recovery longer than it should. The logs from that exact moment were gone by the time I looked, so the recovery stall is an inference.

## Why it came back after I "fixed" it

This is the part I'd like to save you from.

1. **I deleted the pod and nothing happened for 30 minutes.** The pod's grace period was 1800 seconds. I believe the stuck backends blocked a clean shutdown, so Kubernetes waited the full 30 minutes. That's an inference, but it matches the numbers.
2. **The replacement pod hung in the same way.** I had merged the fix, but Flux was **suspended**, so the change was never applied. Merged is not applied.
3. **The CloudNativePG gotcha.** Setting `spec.securityContext` on the cluster *replaces* the operator's default container security context, so you must restate the defaults (non-root, no privilege escalation, dropped capabilities, seccomp) alongside the one new setting.
4. **Helm won't scale Immich back up for you.** I had scaled the app to zero by hand, and the release upgrade left it there. I scaled it back to one myself.

After Flux was resumed, the new spec reached the cluster, the pod was recreated, and the database recovered. Today the pod reports `unconfined`, there are no stuck logins, and the cluster is healthy.

## Before upgrading the rest of the cluster

My next step is upgrading the two remaining 24.04 workers. Before that, I checked which Postgres instances could break:

- **Every container image in the cluster**, grouped by node, filtered for databases
- **Environment variables** that mention a database on every deployment, statefulset and cronjob
- **Volumes pinned to a node**, since local volumes decide where an app can run
- **Every manifest in the repo**, to catch anything defined but not currently running

The answer was reassuring. There are exactly two Postgres instances. Both already run on 26.04 nodes and both have the workaround. Neither of the two remaining workers runs one. Forgejo is on SQLite. Everything else is Redis or Valkey, a web app, a GPU service or Ceph. I also checked Ceph, because one of those workers hosts a monitor and an OSD: it was `HEALTH_OK` and the pools tolerate one node down, so I'll upgrade one node at a time and wait for the cluster to settle in between.

## Is this only Ubuntu?

It isn't an Ubuntu bug, but Ubuntu 26.04 is where it showed up first. The bad rule is in containerd's upstream AppArmor template. Three things have to line up: AppArmor is the active security module, profile stacking is in play, and containerd's template has no signal rule for the stacked peer. I haven't tested other distributions. My reading of the reports is that Debian has AppArmor on by default and could hit it with a newer kernel, and that Talos defaults to SELinux so it probably doesn't. Changing distro isn't a fix on its own. What matters is whether AppArmor is active and which kernel, AppArmor and containerd versions you run.

## Where upstream stands (checked on Nov 17)

- The issue on containerd's tracker is still open.
- A fix to the AppArmor template (`apparmor: allow signals and ptrace for stacked profile peers`) was **merged into containerd's main branch on Nov 16**.
- It is in no release yet. The newest containerd releases are from mid-October, and my k3s bundles one of those. When a k3s release picks up a containerd that includes the fix, I'll test removing the workaround.

## What I'm taking away

1. **`ps` state `S` versus `D`** tells you "waiting on another process" from "waiting on I/O".
2. **A "Permission denied" from the same user** means check the kernel log, not file permissions.
3. **`kubectl exec` works when `psql` doesn't.** Postgres process titles show what every connection is doing.
4. **A workaround for one pod isn't a fix for the node.** After the first incident I should have audited every Postgres on that node. I didn't.
5. **Merged is not applied.** Know whether your GitOps controller is actually running.
6. **Know your grace periods.** Deleting a wedged pod can take as long as the grace period.
7. **Automated upgrades restart your databases, so test your backups.** Mine had been failing for 15 days when I looked. For the last three days it was this problem. I haven't found why the first twelve failed.
8. **Upgrade one node at a time.** The 24.04 node was my control, and it's why I knew the problem was new.

