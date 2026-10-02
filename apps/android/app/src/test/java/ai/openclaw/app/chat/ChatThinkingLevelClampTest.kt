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
    // Gateway excludes Ultra from auto-fallback; adaptive clamps to Off.
    assertEquals("off", clampThinkingLevelToOptions("adaptive", options("off", "ultra")))
  }

  @Test
  fun highEffortClampsToOffOnOffUltraProfile() {
    // Align with Gateway resolveSupportedThinkingLevelFromProfile: never auto-fallback to Ultra.
    assertEquals("off", clampThinkingLevelToOptions("high", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("max", options("off", "ultra")))
    assertEquals("off", clampThinkingLevelToOptions("xhigh", options("off", "ultra")))
  }

  @Test
  fun prefersNearestNonUltraWhenAvailable() {
    // Off/High/Ultra: medium floors onto High (Ultra excluded from fallback).
    assertEquals("high", clampThinkingLevelToOptions("medium", options("off", "high", "ultra")))
    assertEquals("high", clampThinkingLevelToOptions("xhigh", options("off", "high", "ultra")))
  }

  @Test
  fun soleUltraAdvertisedDoesNotAutoSelectUltra() {
    // Gateway never auto-opts into Ultra; explicit Ultra is membership-only.
    assertEquals("off", clampThinkingLevelToOptions("medium", options("ultra")))
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
