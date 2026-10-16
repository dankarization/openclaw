package ai.openclaw.app.ui.chat

import ai.openclaw.app.chat.ChatMessageContent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatAttachmentMessageTest {
  private val image = ChatMessageContent(type = "image", mimeType = "image/jpeg", fileName = "1000186721.jpg")
  private val voice = ChatMessageContent(type = "audio", mimeType = "audio/mp4", fileName = "voice-note-b9526ed8.m4a", durationMs = 76_000)

  @Test
  fun placeholderTextIsDroppedWhenTheMessageCarriesAttachments() {
    val parts = splitChatAttachmentMessage(listOf(image, ChatMessageContent(type = "text", text = "See attached."), voice))
    assertEquals(listOf(image, voice), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun placeholderTextStaysWhenItIsTheWholeTextOnlyMessage() {
    val text = ChatMessageContent(type = "text", text = "See attached.")
    assertEquals(listOf(text), splitChatAttachmentMessage(listOf(text)).content)
  }

  @Test
  fun transcriptionMarkerIsSplitOutOfTheTextAndUnquoted() {
    val text = ChatMessageContent(type = "text", text = "See attached.\n**[Transcription]**\n> First line.\n> Second line.")
    val parts = splitChatAttachmentMessage(listOf(image, text, voice))
    assertEquals(listOf(image, voice), parts.content)
    assertEquals("First line.\nSecond line.", parts.transcript)
  }

  @Test
  fun authorTextSurvivesNextToTheTranscript() {
    val text = ChatMessageContent(type = "text", text = "Check this\n**[Transcription]**\n> spoken")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(ChatMessageContent(type = "text", text = "Check this")), parts.content)
    assertEquals("spoken", parts.transcript)
  }

  @Test
  fun ordinaryMarkdownIsUntouched() {
    val text = ChatMessageContent(type = "text", text = "**bold** and > not a transcript")
    val parts = splitChatAttachmentMessage(listOf(text))
    assertEquals(listOf(text), parts.content)
    assertNull(parts.transcript)
  }

  @Test
  fun collapseThresholdIsAFractionOfTheVisibleChatHeight() {
    assertEquals(0.6f, ChatAdaptiveCollapsePolicy.VIEWPORT_FRACTION)
    assertFalse(ChatAdaptiveCollapsePolicy.shouldCollapse(contentHeightPx = 1_200, viewportHeightPx = 2_400))
    assertFalse(ChatAdaptiveCollapsePolicy.shouldCollapse(contentHeightPx = 1_440, viewportHeightPx = 2_400))
    assertTrue(ChatAdaptiveCollapsePolicy.shouldCollapse(contentHeightPx = 1_441, viewportHeightPx = 2_400))
    assertFalse(ChatAdaptiveCollapsePolicy.shouldCollapse(contentHeightPx = 5_000, viewportHeightPx = 0))
  }

  @Test
  fun generatedVoiceNoteNamesAreHidden() {
    assertTrue(isGeneratedVoiceNoteName("voice-note-b9526ed8-69ef.m4a"))
    assertFalse(isGeneratedVoiceNoteName("meeting.m4a"))
  }
}
