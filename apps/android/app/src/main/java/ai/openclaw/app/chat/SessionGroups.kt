package ai.openclaw.app.chat

import ai.openclaw.app.node.asArrayOrNull
import ai.openclaw.app.node.asObjectOrNull
import ai.openclaw.app.node.asStringOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** One gateway session-group catalog entry (`sessions.groups.*`). */
internal data class GatewaySessionGroup(
  val name: String,
  val position: Int,
)

private val sessionGroupsJson = Json { ignoreUnknownKeys = true }

/**
 * Parses a `sessions.groups.list` / mutation payload.
 * Null when `groups` is absent so a partial error body cannot wipe the catalog cache.
 */
internal fun parseSessionGroupsPayload(payload: String): List<GatewaySessionGroup>? {
  val root =
    runCatching { sessionGroupsJson.parseToJsonElement(payload).asObjectOrNull() }.getOrNull()
      ?: return null
  val groups = root["groups"].asArrayOrNull() ?: return null
  return groups
    .mapIndexedNotNull { index, element ->
      val record = element.asObjectOrNull() ?: return@mapIndexedNotNull null
      val name = record["name"].asStringOrNull()?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapIndexedNotNull null
      val position = (record["position"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: index
      GatewaySessionGroup(name = name, position = position)
    }.sortedWith(compareBy<GatewaySessionGroup> { it.position }.thenBy { it.name })
}
