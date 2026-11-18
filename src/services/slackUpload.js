/**
 * Uploads a call recording to a Slack thread, surviving channels the bot is
 * not a member of.
 *
 * `chat:write.public` lets the bot post messages to any public channel, so the
 * call thread is created fine in `#client-*` channels — but `files.uploadV2`
 * requires membership and fails with `not_in_channel`. On that error we try to
 * join the channel once and retry. The result is returned instead of thrown so
 * a failed upload never prevents the transcript (and the OTP) from being posted.
 */

const NOT_IN_CHANNEL = 'not_in_channel';

/** Slack platform error code (e.g. "not_in_channel"), or the message. */
function slackErrorCode(err) {
  return err?.data?.error || err?.message || String(err);
}

/**
 * @param {{ files: { uploadV2: Function }, conversations: { join: Function } }} client
 * @param {{ channel: string, threadTs: string, buffer: Buffer, filename: string, title: string }} params
 * @returns {Promise<{ ok: boolean, joined?: boolean, error?: string, joinError?: string }>}
 */
async function uploadFileToThread(client, { channel, threadTs, buffer, filename, title }) {
  const upload = () => client.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file: buffer,
    filename,
    title,
  });

  try {
    await upload();
    return { ok: true };
  } catch (err) {
    const error = slackErrorCode(err);
    if (error !== NOT_IN_CHANNEL) return { ok: false, error };
  }

  try {
    await client.conversations.join({ channel });
  } catch (joinErr) {
    return { ok: false, error: NOT_IN_CHANNEL, joinError: slackErrorCode(joinErr) };
  }

  try {
    await upload();
    return { ok: true, joined: true };
  } catch (err) {
    return { ok: false, joined: true, error: slackErrorCode(err) };
  }
}

/** Thread notice for a failed upload — tells Ops exactly how to fix it. */
function uploadFailureNotice(result) {
  if (result.error === NOT_IN_CHANNEL) {
    return '⚠️ No se pudo subir el audio: el bot no está en este canal. '
      + 'Invitá a @Walkie Talkie con `/invite @Walkie Talkie` para recibir las grabaciones.';
  }
  return `⚠️ No se pudo subir el audio a Slack (${result.error}). La transcripción va abajo.`;
}

module.exports = { uploadFileToThread, uploadFailureNotice, slackErrorCode, NOT_IN_CHANNEL };
