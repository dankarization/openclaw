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
  }

  @Test
  fun missingGroupsArrayIsNotAnEmptyCatalog() {
    assertNull(parseSessionGroupsPayload("""{"ok":true}"""))
    assertNull(parseSessionGroupsPayload("not-json"))
    assertEquals(emptyList<GatewaySessionGroup>(), parseSessionGroupsPayload("""{"groups":[]}"""))
  }
}
