import { describe, expect, it } from "vitest";
import { isPrivateAddress, parseFeed } from "../src/feed.js";

const SAMPLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Test Show</title>
    <itunes:author>Test Author</itunes:author>
    <description>A show</description>
    <itunes:image href="https://img.example.com/show.jpg"/>
    <item>
      <title>Ep One</title>
      <guid isPermaLink="false">guid-1</guid>
      <pubDate>Tue, 10 Jun 2025 10:00:00 GMT</pubDate>
      <itunes:duration>1:02:03</itunes:duration>
      <enclosure url="https://cdn.example.com/1.mp3" type="audio/mpeg" length="1000"/>
    </item>
    <item>
      <title>Ep Two</title>
      <guid>guid-2</guid>
      <itunes:duration>90</itunes:duration>
      <itunes:image href="https://img.example.com/ep2.jpg"/>
      <enclosure url="https://cdn.example.com/2.mp3" type="audio/mpeg"/>
    </item>
    <item>
      <title>No enclosure</title>
      <guid>guid-3</guid>
    </item>
  </channel>
</rss>`;

describe("parseFeed", () => {
  const feed = parseFeed("https://feeds.example.com/rss.xml", SAMPLE);

  it("reads channel metadata", () => {
    expect(feed.title).toBe("Test Show");
    expect(feed.author).toBe("Test Author");
    expect(feed.image).toBe("https://img.example.com/show.jpg");
  });

  it("keeps only playable items (with an enclosure)", () => {
    expect(feed.episodes).toHaveLength(2);
    expect(feed.episodes.map((e) => e.guid)).toEqual(["guid-1", "guid-2"]);
  });

  it("parses HH:MM:SS and seconds durations", () => {
    expect(feed.episodes[0].durationSeconds).toBe(3723);
    expect(feed.episodes[1].durationSeconds).toBe(90);
  });

  it("parses enclosure + pubDate and inherits the show image", () => {
    expect(feed.episodes[0].enclosureUrl).toBe("https://cdn.example.com/1.mp3");
    expect(feed.episodes[0].enclosureType).toBe("audio/mpeg");
    expect(feed.episodes[0].pubDateMs).toBe(Date.parse("Tue, 10 Jun 2025 10:00:00 GMT"));
    expect(feed.episodes[0].image).toBe("https://img.example.com/show.jpg"); // inherited
    expect(feed.episodes[1].image).toBe("https://img.example.com/ep2.jpg"); // own
  });
});

describe("isPrivateAddress (SSRF guard)", () => {
  it("flags loopback/private/link-local/CGNAT v4", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
  });
  it("allows public v4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  });
  it("handles v6 loopback/link-local/unique-local and mapped v4", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("catches IPv4-mapped IPv6 in hex form, not just dotted", () => {
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);  // 127.0.0.1
    expect(isPrivateAddress("::ffff:0a00:1")).toBe(true);  // 10.0.0.1
    expect(isPrivateAddress("::ffff:c0a8:101")).toBe(true); // 192.168.1.1
    expect(isPrivateAddress("::ffff:0808:0808")).toBe(false); // 8.8.8.8 (public)
  });
});
