package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Test

class ChatThinkingLevelClampTest {
  private fun options(vararg ids: String): List<ChatThinkingLevelOption> =
    ids.map { ChatThinkingLevelOption(id = it, label = it) }

  @Test
  fun membershipWins() {
    assertEquals("ultra", clampThinkingLevelToOptions("ultra", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("off", options("off", "ultra")))
  }

  @Test
  fun preservesUltraWhenOmittedFromAdvertisedOptions() {
    assertEquals(
      "ultra",
      clampThinkingLevelToOptions("ultra", options("off", "high", "xhigh", "max")),
    )
  }

  @Test
  fun clampsMediumToOffOnOffUltraProfile() {
    // Growter / DeepSeek Flash advertises Off+Ultra only; Medium must never stick.
    assertEquals("off", clampThinkingLevelToOptions("medium", options("off", "ultra")))
  }

  @Test
  fun ambiguousAdaptivePrefersOffOnOffUltraProfile() {
    // Equal rank distance between Off and Ultra → prefer Off (safer / cheaper).
    assertEquals("off", clampThinkingLevelToOptions("adaptive", options("off", "ultra")))
  }

  @Test
  fun highEffortClampsTowardUltraWhenCloser() {
    assertEquals("ultra", clampThinkingLevelToOptions("high", options("off", "ultra")))
    assertEquals("ultra", clampThinkingLevelToOptions("max", options("off", "ultra")))
    assertEquals("ultra", clampThinkingLevelToOptions("xhigh", options("off", "ultra")))
  }

  @Test
  fun prefersSoleNonOffWhenOffAbsent() {
    assertEquals("ultra", clampThinkingLevelToOptions("medium", options("ultra")))
  }

  @Test
  fun unknownLevelPrefersOff() {
    assertEquals("off", clampThinkingLevelToOptions("custom-level", options("off", "ultra")))
  }

  @Test
  fun emptyOptionsPassthrough() {
    assertEquals("medium", clampThinkingLevelToOptions("medium", emptyList()))
  }
}
