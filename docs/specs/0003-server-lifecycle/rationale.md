# 0003. Server lifecycle, rationale

## Context

The plugin owns the Obscura engine process. Today's scaffold spawns a fresh engine for every probe and tears it down after, which is fine for a one off capability check but wrong for a session where the agent opens pages, reads them, and acts on them: each call would pay a cold start, and nothing supervises the engine in between.

The scope row for feature 5 asks for the opposite shape: start, watch, and stop the engine with the session, so tools always have a live engine behind them without the user managing processes. Spec 0001 already fixed the detection side of the problem: an exit listener on the spawned process plus a WebSocket close handler mark the engine dead. It explicitly left the reaction open: whether and how to auto restart is this feature's decision.

The forces that shape the choice:

- Page state (current URL, history, DOM) lives inside the engine. When the engine dies, that state is gone regardless of what the plugin does next; nothing in the process can recover a page the engine itself lost.
- pi can dispatch several tool calls in parallel, and spec 0001 routes all CDP work through one queue. A death therefore hits a queue, not a single call, and the reaction must decide what happens to everyone waiting behind the failing call.
- Obscura is a single local binary on the user's machine. Its failure modes are simple and bounded: it fails to start, it dies mid flight, or a stale instance from an earlier session holds the port. There is no fleet, no load balancer, no cross host concern.
- The same plugin runs under a hot reload, which tears the extension module down and reloads it; and the user may close pi at any time, cleanly or not.

## Options considered

### Option 1: Fail the call, restart on demand

The engine is supervised by a small state machine. Death is detected by the existing exit listener and WS close handler. The call that hits a dead engine fails in plain words. Every browser tool call runs an ensure step at the front of the shared queue: if the engine is stopped it spawns one, if it is starting it awaits the in flight spawn, if it is broken it fails fast, and if it is ready it proceeds.

**Pros**:
- No supervisor machinery: no backoff timer, no restart counter for the normal path, no tuning knobs.
- Transparent to the agent: the message says exactly what died and what was lost, and the next call recovers without user action.
- A broken binary fails fast after two attempts, in milliseconds, instead of burning the endpoint timeout forever.
- Fits the one queue from spec 0001 naturally: the ensure is just the first step of queued work.

**Cons**:
- The page is always lost on death; the agent must re read, and the failure is visible in the tool result instead of being hidden by an automatic respawn.
- A runtime crash loop (engine dies after becoming ready, so the spawn counter never trips) is not caught; each call pays one restart, bounded only by the endpoint timeout.

### Option 2: Auto restart with capped backoff

A supervisor loop watches the process and respawns it with growing delays (for example 1s, 2s, 4s, capped), so a transient death is invisible to the agent; tool calls wait for the engine to come back, possibly with an in flight retry.

**Pros**:
- A one off blip is transparent; the agent never sees the failure and keeps working on the same flow.
- Feels robust, the classic "keep the service up" instinct.

**Cons**:
- The very thing that died was the page. An invisible restart still hands the agent a blank engine, so the transparency buys nothing for the actual work; the agent only discovers the loss later, when it reads, and then without the message that would explain it.
- Masks a persistent crash as slow responses, which is the worst failure for an agent to diagnose.
- Real machinery: a backoff timer, restart state, a retry policy on in flight calls, and a crash loop threshold anyway, since unbounded restart is dangerous. That threshold is essentially Option 3.

### Option 3: Auto restart once, then fail

The plugin respawns the engine once immediately after a death; if it dies again within the session, later calls fail in plain words.

**Pros**:
- Covers a genuine one off blip transparently, which is the strongest case for any auto restart.

**Cons**:
- Adds a crash counter; Option 1 already handles the blip case (the next call restarts) with barely more user visible cost.
- The transparency still hides the page loss, the same objection as Option 2.

## Rationale

Option 1 wins because it matches the real cost structure of this system. The dominant fact from Context is that page state lives in the engine and dies with it. Once that is accepted, an invisible restart is not a benefit, it is a lie: the agent believes its page is still there and discovers otherwise only on the next read, with no message explaining why. Failing loudly in plain words turns the death into information the agent can act on, which is strictly more useful than hiding it.

The transparency argument for a backoff supervisor also overstates how often Obscura dies. This is one local process on the user's machine, not a fleet under load. Its failure modes are the bounded set in Context: won't start, dies mid flight, or a stale port. Option 1 handles each honestly: fail fast after two bad starts for the first, plain message plus restart on next call for the second, report never kill for the third. Option 2's machinery exists to smooth over frequent failures, and this system does not have them.

The cost of Option 1 is small and explicit. The page is lost on death, which is true under every option anyway. A crash loop after ready is not caught by the fail fast marker, but each attempt is bounded by the endpoint timeout and a browser engine that dies seconds after becoming ready is rare; if it ever becomes common, the crash counter from Option 3 is a five line addition, and the spec says so in its tradeoffs rather than building it now.

The queue ownership rule (first call owns the restart, the rest wait) falls out of what spec 0001 already decided. The queue exists, so the ensure step simply lives at its front; sharing the in flight spawn promise is the natural way to keep exactly one restart under parallel dispatch.