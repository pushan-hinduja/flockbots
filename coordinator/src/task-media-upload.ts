/**
 * Shared Supabase Storage upload helper used by both QA and wireframe
 * pipelines. Each caller supplies its own bucket + key so the namespacing
 * stays clean (qa-media has timestamp-suffixed keys; wireframes has
 * per-round paths).
 *
 * Returns a 7-day signed URL on success. Returns null when:
 *   - Supabase isn't configured (CLI-only mode)
 *   - the upload fails
 *   - the signed-URL request fails
 *
 * Callers handle logging at their own granularity — this helper stays
 * silent so each pipeline can keep its existing log-event vocabulary.
 */

export interface UploadTaskMediaOptions {
  bucket: string;
  /** Pre-built object key (e.g. `inst-1/<task>/round-1/01-empty-desktop.png`). */
  key: string;
  buffer: Buffer;
  contentType: string;
  /** Default false — fail on conflict. Wireframes pass true to overwrite within a round. */
  upsert?: boolean;
  /** Signed URL TTL in seconds. Defaults to 7 days. */
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function uploadTaskMedia(opts: UploadTaskMediaOptions): Promise<string | null> {
  try {
    const { getSupabaseClient } = await import('./supabase-sync');
    const supabase = getSupabaseClient();
    if (!supabase) return null;

    const { error: uploadErr } = await supabase.storage.from(opts.bucket).upload(
      opts.key,
      opts.buffer,
      {
        contentType: opts.contentType,
        upsert: opts.upsert ?? false,
      },
    );
    if (uploadErr) return null;

    const { data: signed, error: signErr } = await supabase.storage
      .from(opts.bucket)
      .createSignedUrl(opts.key, opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) return null;

    return signed.signedUrl;
  } catch {
    return null;
  }
}
