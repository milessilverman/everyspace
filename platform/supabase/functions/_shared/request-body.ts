export class BodyLimitError extends Error {}

/** Limit bytes and time before parsing user input or verifying signed raw requests. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length')) > maxBytes) throw new BodyLimitError();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const buffer = new Uint8Array(maxBytes);
  const deadline = AbortSignal.timeout(5_000);
  const cancel = () => { reader.cancel().catch(() => {}); };
  deadline.addEventListener('abort', cancel, { once: true });
  try {
    let offset = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (deadline.aborted) throw new Error('Request body timed out.');
      if (done) return buffer.subarray(0, offset);
      if (offset + value.length > maxBytes) { cancel(); throw new BodyLimitError(); }
      buffer.set(value, offset);
      offset += value.length;
    }
  } finally {
    deadline.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
