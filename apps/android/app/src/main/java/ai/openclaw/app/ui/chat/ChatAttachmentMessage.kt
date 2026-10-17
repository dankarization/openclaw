package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent

/** Placeholder the send path uses when the composer text is empty but attachments exist. */
internal const val CHAT_ATTACHMENT_PLACEHOLDER_TEXT = "See attached."

/**
 * One user message as rendered: attachments plus the author's own text, with any
 * transcription split out so it can sit under the voice row instead of inside the text.
 */
internal data class ChatAttachmentMessageParts(
  val content: List<ChatMessageContent>,
  val transcript: String?,
) {
  /**
   * Text the link preview scans: the author's text first, then the transcript, so a URL
   * spoken in the voice note still previews after the transcript moves out of the text.
   */
  val linkPreviewContent: List<ChatMessageContent>
    get() = if (transcript == null) content else content + ChatMessageContent(type = "text", text = transcript)
}

private val TRANSCRIPTION_MARKER = Regex("""^\s*\**\s*\[\s*Transcri(?:ption|pt)\s*]\s*\**\s*:?\s*$""", RegexOption.IGNORE_CASE)

/**
 * Splits `**[Transcription]**` + quoted lines (or any payload when the turn carries a
 * voice note) out of user text and drops an exact "See attached." placeholder body when
 * the message carries any attachment.
 * Text without attachments or markers is returned unchanged.
 */
internal fun splitChatAttachmentMessage(content: List<ChatMessageContent>): ChatAttachmentMessageParts {
  val hasAttachment = content.any { it.type != "text" }
  val hasVoiceNote = content.any { it.type == "audio" || it.mimeType?.startsWith("audio/") == true }
  val transcripts = mutableListOf<String>()
  val parts =
    content.mapNotNull { part ->
      if (part.type != "text") return@mapNotNull part
      val (body, transcript) = splitTranscriptText(part.text.orEmpty(), hasVoiceNote)
      transcript?.let(transcripts::add)
      val cleaned = if (hasAttachment || transcript != null) stripAttachmentPlaceholder(body) else body
      when {
        cleaned == part.text -> part
        cleaned.isBlank() -> null
        else -> part.copy(text = cleaned)
      }
    }
  return ChatAttachmentMessageParts(parts, transcripts.joinToString("\n\n").takeIf { it.isNotBlank() })
}

// The sender only synthesizes the placeholder for an entirely empty caption, so only an exact
// placeholder body is dropped; a caption that merely starts with it is the author's text.
private fun stripAttachmentPlaceholder(text: String): String = if (text.trim() == CHAT_ATTACHMENT_PLACEHOLDER_TEXT) "" else text

private fun splitTranscriptText(
  text: String,
  hasVoiceNote: Boolean,
): Pair<String, String?> {
  val lines = text.lines()
  val markerIndex = lines.indexOfFirst { TRANSCRIPTION_MARKER.matches(it) }
  if (markerIndex < 0) return text to null
  val payload = lines.drop(markerIndex + 1).dropWhile { it.isBlank() }.dropLastWhile { it.isBlank() }
  // A bare marker with no payload is not a transcript; keep the author's text as written.
  if (payload.isEmpty()) return text to null
  // Without a voice note, only the quoted transcript block counts; an authored
  // `[Transcription]` heading over plain text stays ordinary message text.
  val quoted = payload.all { it.isBlank() || it.trimStart().startsWith(">") }
  if (!quoted && !hasVoiceNote) return text to null
  val transcript =
    payload
      .joinToString("\n") { line -> line.trimStart().removePrefix(">").removePrefix(" ") }
      .trim()
  if (transcript.isEmpty()) return text to null
  val body = lines.take(markerIndex).joinToString("\n").trim()
  return body to transcript
}
