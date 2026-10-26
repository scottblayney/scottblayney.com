+++
date = '2026-10-25T18:33:00-07:00'
title = 'Running a Local LLM on My Homelab k3s Cluster'
description = 'Ollama and Open WebUI on a GPU node in my k3s cluster, built with a lot of help from Claude and Claude Code.'
tags = ['Homelab', 'Kubernetes', 'k3s', 'LLM', 'Ollama', 'GitOps']
draft = false
+++

I got a local LLM running on my k3s cluster: Ollama and Open WebUI, served at my own domain. Here's how it went, and how much of it was me versus AI.

First, I need to be upfront. I didn't build most of the Kubernetes side myself. I used a regular Claude chat for research and planning, and Claude Code for the repo and cluster work. I'd rather say that plainly than post it like I'd hand-crafted every manifest.

Everything lives in my [k3s-cluster repo](https://github.com/scottblayney/k3s-cluster) if you want to follow along. The [Ollama](https://github.com/scottblayney/k3s-cluster/blob/main/apps/base/llm/ollama.yaml) and [Open WebUI](https://github.com/scottblayney/k3s-cluster/blob/main/apps/base/llm/open-webui.yaml) manifests are in `apps/base/llm/`, and the [NVIDIA device plugin](https://github.com/scottblayney/k3s-cluster/tree/main/infrastructure/controllers/nvidia-device-plugin) is under `infrastructure/controllers/`.

Here's how it went, step by step, with the decisions I made along the way.

## 1. Pick the hardware

I had an old GTX 1060 with 3GB of VRAM. A used RTX 3060 12GB was the better long-term card, but it wasn't in the budget. I decided to build the GPU node plumbing on the 1060 first and upgrade later if it was worth it.

## 2. Build the node

I installed the card in a PC, installed Ubuntu Server, and joined it to the cluster as "kubert", my new GPU node. The cluster is now 4 nodes: three Dells plus kubert. It runs Flux with secrets in SOPS/age.

## 3. Get the driver right (me, with the chat)

The 1060 is Pascal, and NVIDIA's 580 branch is the last driver that supports it. Newer drivers don't, and the open kernel modules never supported it. The chat found the Ubuntu 580-server branch with prebuilt modules, and wrote an apt pin so nothing can pull in a newer branch. I installed the driver and the Container Toolkit myself, and fixed a broken persistence-mode setting over a few rounds of trial and error.

## 4. Make the cluster see the GPU (me, with the chat)

k3s detected the NVIDIA runtime on its own. I labeled and tainted kubert so only GPU workloads land there, and added the NVIDIA device plugin through Flux. The chat drafted the manifests and caught that the chart's default affinity expects Node Feature Discovery labels I don't have. Labeling kubert `nvidia.com/gpu.present=true` satisfies it instead. I committed and pushed.

## 5. Decision: Ollama, not KServe

My first plan was KServe, partly as a portfolio piece. The chat pointed out that KServe's default LLM runtime (vLLM) doesn't support Pascal. I decided to use Ollama now and come back to KServe when I have better hardware.

## 6. Decision: how to expose it

I wanted anyone on my network to be able to use it. The chat explained that Ollama's API has no authentication, so exposing it directly lets anyone on the wifi pull or delete models. I decided that Open WebUI would be the only thing exposed, and only through a Cloudflare tunnel. Both services are ClusterIP, so nothing is reachable directly on my LAN. At home or away, everyone goes through the tunnel and Open WebUI's login.

It also warned that Cloudflare cuts requests at about 100 seconds, which matters when a slow GPU takes a while to produce the first token, but this hasn't been an issue.

## 7. The build (mostly Claude Code)

The chat had drafted the first manifests with placeholders. For the real build I gave Claude Code access to my cluster repo and kubectl, then mostly approved and reviewed what it proposed. It:

- Wrote the Ollama and Open WebUI deployments: `runtimeClassName: nvidia`, a GPU request, a toleration for the GPU taint, a node selector, and PVCs for models and for Open WebUI.
- Created the Cloudflare tunnel and DNS record, SOPS-encrypted the credentials, committed, pushed, and let Flux reconcile.
- Pulled `llama3.2:3b` and tested that it was actually using the GPU.

That part took one evening.

## What I learned along the way

1. **Tainting the GPU node has side effects.** Anything without a toleration stays off kubert, including DaemonSets and upgrade job pods. My k3s upgrade quietly stalled on that node until Claude Code spotted it and added the toleration to the upgrade plan.
2. **Use `Recreate` for single-GPU, single-volume workloads.** A rolling update would try to start a second pod that can't get the GPU or the volume.
3. **3GB of VRAM is tight.** Only about 75% of a 3B model fits on the card, and the rest runs on CPU. It works, just slowly. Smaller or more heavily quantized models fit better.
4. **Open WebUI's first account becomes admin.** You need signup on to create that account, so claim it right away, then turn signup off.

## My take on using AI for this

I'm working toward Kubestronaut, so I go back and forth on this. Handing it off saved me a lot of time, and I understand what's running because I reviewed every change and asked why. But reviewing YAML isn't the same as writing it from scratch, and I know the exam won't let me lean on an assistant. My plan is to go back through the manifests line by line and rebuild a piece or two by hand.

Where do you draw the line between "getting it done" and "learning it"? I don't think I've found mine yet.

## What's next

Web search in Open WebUI with a self-hosted SearXNG. I'll write that up when it's done.
