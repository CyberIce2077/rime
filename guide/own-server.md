# Your own server

Rime can run on a llama.cpp server on another machine, such as a GPU box at home,
and start it only when you need it. All it needs is an ssh host you can already
log in to without a password.

```
# ~/.ssh/config
Host gpubox
  HostName gpubox.local
  User me
```

## Setting it up

Run `/setup` and choose **your own server**, then pick the host. Rime checks over
ssh that it answers, finds the `llama-server` service and its models, and shows
the steps it will run. It changes nothing on the machine until you start.

No ssh? Type the server's URL (`http://gpubox.local:8080`) and Rime talks to it
directly.

## The steps

Each start runs these in order. A step that's already done finishes at once, so
a normal start with the server on takes well under a second.

| Step | Default command |
|---|---|
| wake | `wake-on-lan {mac}`, skipped when the host already answers |
| connect | `ssh -o BatchMode=yes {host} true` |
| tunnel | `ssh -N -o ExitOnForwardFailure=yes -L {port}:127.0.0.1:8080 {host}`; Rime keeps it open |
| start | `sudo systemctl start llama-server` |
| load | `POST /models/load {"model":"{model}"}` (router mode) |
| warm cache | sends the tools and system prompt so the first reply starts fast |
| test | one short reply |

You can edit or skip **wake**, **connect**, **tunnel**, **start** and **load** in
the setup screen. `{host}`, `{port}`, `{model}` and `{mac}` are filled in when the
step runs. Only the steps you change are saved. **warm cache** and **test** are
built in.

Wake-on-LAN needs the machine's MAC address and works only on the same network.
Without one, turn the machine on yourself.

## While Rime runs

`/server` shows the server's state, its models and slots, and lets you switch
model, stop the service or power the machine off. Each action shows the exact
command first.

Under **Server** in `/settings`:

- **when Rime quits**: keep running (default), stop the server, or power off.
- **wake when needed**: send Wake-on-LAN when the machine is off.

Before stopping or powering off, Rime can save the prompt cache to the server's
disk so the next start picks up where you left off.
