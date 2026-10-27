import { getJob, subscribe } from "@/core/jobs";
import type { Job } from "@/core/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 3600;

type Params = { params: Promise<{ id: string }> };

/**
 * Server-sent events stream for one job. Chosen over polling so a 20-file batch
 * reports each file as it lands, and over WebSockets because the traffic is
 * one-directional and SSE reconnects on its own.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  if (!getJob(id)) return new Response("Is bulunamadi.", { status: 404 });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (job: Job) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
        } catch {
          closed = true;
        }
        if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
          close();
        }
      };

      const unsubscribe = subscribe(id, send);
      // Heartbeat: keeps intermediaries from closing an idle stream during a
      // long single-file encode that reports no progress for minutes.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 15_000);

      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed by the client disconnecting */
        }
      }

      request.signal.addEventListener("abort", close);

      // Emit current state immediately so a late subscriber is not left blank.
      const current = getJob(id);
      if (current) send(current);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
