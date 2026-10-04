package ai.openclaw.app.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionGroupsTest {
  @Test
  fun parsesCatalogOrderAndSkipsBlankNames() {
    val groups =
      parseSessionGroupsPayload(
        """{"ok":true,"groups":[{"name":" dankar ","position":1},{"name":"CODEX","position":0},{"name":" ","position":2},{"position":3}],"sectionOrder":["category:CODEX"]}""",
      )

    assertEquals(listOf("CODEX" to 0, "dankar" to 1), groups?.map { it.name to it.position })
    assertEquals(
      listOf("category:CODEX"),
      parseSessionGroupCatalog(
        """{"ok":true,"groups":[{"name":"CODEX","position":0}],"sectionOrder":["category:CODEX","nope",""]}""",
      )?.sectionOrder,
    )
  }

  @Test
  fun missingGroupsArrayIsNotAnEmptyCatalog() {
    assertNull(parseSessionGroupsPayload("""{"ok":true}"""))
    assertNull(parseSessionGroupsPayload("not-json"))
    assertEquals(emptyList<GatewaySessionGroup>(), parseSessionGroupsPayload("""{"groups":[]}"""))
  }

  @Test
  fun offUltraShapeDoesNotMatterHereAndLegacyIsNotAnotherGatewaysCatalog() {
    val restricted =
      decideSessionGroupMigration(
        listedNames = emptyList(),
        legacyNames = listOf("Folder"),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(true, restricted.putLegacy)
    assertEquals(true, restricted.consumeLegacy)

    val otherGateway =
      decideSessionGroupMigration(
        listedNames = emptyList(),
        legacyNames = emptyList(),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(false, otherGateway.putLegacy)
    assertEquals(false, otherGateway.consumeLegacy)

    val nonempty =
      decideSessionGroupMigration(
        listedNames = listOf("Work"),
        legacyNames = listOf("Folder"),
        alreadyMigrated = false,
        canPut = true,
      )
    assertEquals(false, nonempty.putLegacy)
    assertEquals(true, nonempty.consumeLegacy)
    assertEquals(listOf("Work", "Extra"), unionSessionGroupNames(listOf("Work"), listOf("Extra", "Work")))
  }
}
