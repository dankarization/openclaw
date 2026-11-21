/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { openMessageImage } from "./chat-message-image-open.ts";
import { ticketResponse } from "./chat-message-media.test-helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("never requests unselected original-only sources for the thumbnail strip", async () => {
  const initial = { url: "data:image/png;base64,cG5n", alt: "Initial" };
  const originals = [
    { url: "/workspace/private-a.png", alt: "Local" },
    { url: "file:///workspace/private-b.png", alt: "File" },
    { url: "https://images.example.test/private-c.png", alt: "External" },
  ];
  const fetchMock = vi.fn(async () => ticketResponse("unused"));
  vi.stubGlobal("fetch", fetchMock);
  const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
  openMessageImage(initial, initial.url, {
    sessionKey: "agent:main:main",
    messageId: "opening-message",
    onOpenImage,
    galleryImages: () => ({
      index: 0,
      items: [
        { image: initial, messageId: "opening-message" },
        ...originals.map((image, index) => ({ image, messageId: `message-${index}` })),
      ],
    }),
  });

  const gallery = onOpenImage.mock.calls[0]![0].gallery!;
  const previews = await Promise.all(gallery.thumbnails!.slice(1).map((item) => item.load()));
  expect(previews).toEqual([null, null, null]);
  expect(fetchMock).not.toHaveBeenCalled();
});

it("requests private inbound thumbnail tickets with each image's own message scope", async () => {
  const initial = { url: "data:image/png;base64,cG5n", alt: "Initial" };
  const source = `media://inbound/${crypto.randomUUID()}.png`;
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), window.location.href);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    const messageId = url.searchParams.get("messageId");
    return messageId
      ? ticketResponse(`ticket-${messageId}`)
      : new Response(null, { status: 403 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
  openMessageImage(initial, initial.url, {
    sessionKey: "agent:main:private",
    agentId: "main",
    messageId: "opening-message",
    authToken: "fixture-token",
    onOpenImage,
    galleryImages: () => ({
      index: 0,
      items: [
        { image: initial, messageId: "opening-message" },
        { image: { url: source, alt: "First" }, messageId: "private-one" },
        { image: { url: source, alt: "Second" }, messageId: "private-two" },
        { image: { url: source, alt: "Unidentified" } },
      ],
    }),
  });

  const gallery = onOpenImage.mock.calls[0]![0].gallery!;
  const previews = await Promise.all(gallery.thumbnails!.slice(1).map((item) => item.load()));
  expect(requests).toHaveLength(3);
  expect(requests.map(({ url }) => url.searchParams.get("messageId"))).toEqual([
    "private-one", "private-two", null,
  ]);
  for (const { url, authorization } of requests) {
    expect(url.pathname).toBe("/__openclaw__/assistant-media");
    expect(url.searchParams.get("source")).toBe(source);
    expect(url.searchParams.get("sessionKey")).toBe("agent:main:private");
    expect(url.searchParams.get("meta")).toBe("1");
    expect(authorization).toBe("Bearer fixture-token");
  }
  for (const [index, messageId] of ["private-one", "private-two"].entries()) {
    expect(previews[index]).not.toBeNull();
    const url = new URL(previews[index]!.src);
    expect(url.searchParams.get("messageId")).toBe(messageId);
    expect(url.searchParams.get("mediaTicket")).toBe(`ticket-${messageId}`);
    expect(url.searchParams.get("variant")).toBe("thumbnail");
    expect(url.searchParams.get("width")).toBe("480");
  }
  expect(previews[2]).toBeNull();
});
