package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import kotlin.math.floor

/** Placeholder the send path uses when the composer text is empty but attachments exist. */
internal const val CHAT_ATTACHMENT_PLACEHOLDER_TEXT = "See attached."

/**
 * One user message as rendered: attachments plus the author's own text, with any
 * transcription split out so it can sit under the voice row instead of inside the text.
 */
internal data class ChatAttachmentMessageParts(
  val content: List<ChatMessageContent>,
  val transcript: String?,
)

private val TRANSCRIPTION_MARKER = Regex("""^\s*\**\s*\[\s*Transcri(?:ption|pt)\s*]\s*\**\s*:?\s*$""", RegexOption.IGNORE_CASE)

/**
 * Splits `**[Transcription]**` + quoted lines out of user text and drops the
 * "See attached." placeholder when the message carries any attachment.
 * Text without attachments or markers is returned unchanged.
 */
internal fun splitChatAttachmentMessage(content: List<ChatMessageContent>): ChatAttachmentMessageParts {
  val hasAttachment = content.any { it.type != "text" }
  val transcripts = mutableListOf<String>()
  val parts =
    content.mapNotNull { part ->
      if (part.type != "text") return@mapNotNull part
      val (body, transcript) = splitTranscriptText(part.text.orEmpty())
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

private fun stripAttachmentPlaceholder(text: String): String {
  val trimmed = text.trim()
  if (trimmed == CHAT_ATTACHMENT_PLACEHOLDER_TEXT) return ""
  return if (trimmed.startsWith(CHAT_ATTACHMENT_PLACEHOLDER_TEXT + "\n")) trimmed.removePrefix(CHAT_ATTACHMENT_PLACEHOLDER_TEXT).trim() else text
}

private fun splitTranscriptText(text: String): Pair<String, String?> {
  val lines = text.lines()
  val markerIndex = lines.indexOfFirst { TRANSCRIPTION_MARKER.matches(it) }
  if (markerIndex < 0) return text to null
  val transcript =
    lines
      .drop(markerIndex + 1)
      .joinToString("\n") { line -> line.trimStart().removePrefix(">").removePrefix(" ") }
      .trim()
  val body = lines.take(markerIndex).joinToString("\n").trim()
  if (transcript.isEmpty()) return body to null
  return body to transcript
}

/**
 * Adaptive collapse threshold for long user text and transcripts. A bubble collapses
 * only when its full text would take more than [VIEWPORT_FRACTION] of the visible chat
 * height, so tall screens show whole messages and small screens keep the expander.
 */
internal object ChatAdaptiveCollapsePolicy {
  const val VIEWPORT_FRACTION = 0.6f

  fun maxExpandedHeightPx(viewportHeightPx: Int): Int = floor(viewportHeightPx * VIEWPORT_FRACTION).toInt()

  fun shouldCollapse(
    contentHeightPx: Int,
    viewportHeightPx: Int,
  ): Boolean = viewportHeightPx > 0 && contentHeightPx > maxExpandedHeightPx(viewportHeightPx)
}
