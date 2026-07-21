TIL: ReadWriteOnce doesn't mean one pod. It means one node.

I was working through PersistentVolumes and PVCs today, expecting RWO to lock a volume to a single pod. It doesn't. RWO restricts the volume to a single node, and Kubernetes has no problem letting multiple pods on that same node mount it.

In a small cluster or test environment this stays invisible, since pods for the same workload often land on the same node anyway. The gotcha only shows up when the scheduler moves a pod to a different node (drain, scale event, node pressure) and the volume can't follow because block storage attaches to exactly one node at a time. That pod sits in ContainerCreating waiting on a mount that isn't coming.

There are two real fixes depending on what you actually want:
- Need multiple pods safely sharing read-write access? Use RWX, backed by something that supports it (NFS, EFS, CephFS). Block storage like EBS won't do it.
- Need true single-pod exclusivity, even on the same node? That's what ReadWriteOncePod (RWOP) is for.

#Kubernetes #DevOps #SRE #PlatformEngineering