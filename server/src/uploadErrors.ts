// Structured upload errors (v2.1). Multipart limit violations and parse
// failures used to surface as generic "HTTP 400/500" toasts — the user could
// not tell "too many files" from "file too big" from "bad Excel". Now the
// server maps known failure modes to stable codes + actionable messages and
// the client displays them verbatim.
export interface StructuredUploadError {
  ok: false;
  code: string;
  message: string;
  limit?: number;
  filename?: string;
}

const MULTIPART_MAP: Record<string, { code: string; status: number; message: string; limit?: number }> = {
  // @fastify/multipart: `files` limit exceeded (plus the alias some
  // versions emit).
  FST_FILES_LIMIT: {
    code: 'FILE_COUNT_LIMIT',
    status: 400,
    message: 'Upload stopped: maximum 20 files per request. Try smaller batches of 5–10 files.',
    limit: 20,
  },
  FST_REQ_FILE_COUNT_LIMIT: {
    code: 'FILE_COUNT_LIMIT',
    status: 400,
    message: 'Upload stopped: maximum 20 files per request. Try smaller batches of 5–10 files.',
    limit: 20,
  },
  FST_REQ_FILE_TOO_LARGE: {
    code: 'FILE_TOO_LARGE',
    status: 413,
    message: 'Upload stopped: a file exceeds the 50 MB limit. Split large reports and upload in smaller batches.',
  },
  FST_REQ_PARTS_LIMIT: {
    code: 'PARTS_LIMIT',
    status: 400,
    message: 'Upload stopped: too many parts in the request. Try smaller batches of 5–10 files.',
  },
};

/**
 * Map an error thrown by @fastify/multipart (or an upload watchdog) to a
 * structured response, or null if the error is not a known upload error.
 */
export function structuredUploadError(e: unknown): { status: number; body: StructuredUploadError } | null {
  const code = (e as { code?: string })?.code;
  if (code && code in MULTIPART_MAP) {
    const m = MULTIPART_MAP[code];
    return { status: m.status, body: { ok: false, code: m.code, message: m.message, limit: m.limit } };
  }
  return null;
}

export const UPLOAD_TIMEOUT_CODE = {
  code: 'UPLOAD_TIMEOUT',
  status: 504,
  message: 'Upload timed out. Try smaller batches of 5–10 files.',
} as const;
