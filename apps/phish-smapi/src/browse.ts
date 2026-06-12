import type { SourceBrowseItem, SourceBrowseResponse, SourceTrackInfo } from "@misonos/sonos-protocol";
import { PhishApi, PhishApiError, type PhishShow, type PhishTrack } from "./api.js";
import { decodeId, encodeId, type PhishId } from "./ids.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

interface CacheEntry<T> { value: T; expires: number }

export class PhishBrowser {
  private cache = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly api: PhishApi) {}

  async browse(rawId: string): Promise<SourceBrowseResponse> {
    const id = decodeId(rawId);
    const items = await this.browseId(id);
    return { id: rawId, total: items.length, items };
  }

  async track(rawId: string): Promise<SourceTrackInfo> {
    const id = decodeId(rawId);
    if (id.kind !== "track") throw new Error("Not a track id");
    const track = await this.api.track(id.trackId);
    if (!track.mp3_url) throw new Error("Track has no mp3 URL");
    return {
      id: rawId,
      title: track.title,
      artist: "Phish",
      album: showLabel(track),
      durationSeconds: typeof track.duration === "number" ? Math.round(track.duration / 1000) : undefined,
      url: track.mp3_url,
      mimeType: "audio/mpeg"
    };
  }

  private async browseId(id: PhishId): Promise<SourceBrowseItem[]> {
    switch (id.kind) {
      case "root":
        return [
          container(encodeId({ kind: "years" }), "By Year"),
          container(encodeId({ kind: "songs" }), "By Song"),
          container(encodeId({ kind: "venues" }), "By Venue"),
          container(encodeId({ kind: "tours" }), "By Tour")
        ];
      case "years": {
        const years = await this.cached("years", () => this.api.listYears());
        return years.map((year) => container(encodeId({ kind: "year", year }), year));
      }
      case "songs": {
        const songs = await this.cached("songs", () => this.api.songs());
        return songs.map((song) =>
          container(
            encodeId({ kind: "song", songId: song.slug ?? String(song.id) }),
            song.title,
            song.tracks_count ? `${song.tracks_count} performances` : undefined
          )
        );
      }
      case "venues": {
        const venues = await this.cached("venues", () => this.api.venues());
        return venues.map((venue) =>
          container(
            encodeId({ kind: "venue", venueId: venue.slug ?? String(venue.id) }),
            venue.name,
            [venue.location, venue.shows_count ? `${venue.shows_count} shows` : undefined].filter(Boolean).join(" · ")
          )
        );
      }
      case "tours": {
        const tours = await this.cached("tours", () => this.api.tours());
        return tours
          .map((tour) => {
            const tourId = tour.slug ?? (typeof tour.id === "number" ? String(tour.id) : tourSlugFromName(tour.name));
            if (!tourId) return null;
            return container(
              encodeId({ kind: "tour", tourId }),
              tour.name,
              [tour.starts_on, tour.ends_on].filter(Boolean).join(" → ")
            );
          })
          .filter((item): item is SourceBrowseItem => item !== null);
      }
      case "year": {
        const shows = await this.api.showsByYear(id.year);
        return shows.map(showItem);
      }
      case "song": {
        const shows = await this.api.showsBySong(id.songId);
        return shows.map(showItem);
      }
      case "venue": {
        const shows = await this.api.showsByVenue(id.venueId);
        return shows.map(showItem);
      }
      case "tour": {
        const shows = await this.api.showsByTour(id.tourId);
        return shows.map(showItem);
      }
      case "show": {
        const show = await this.api.show(id.showId);
        const tracks = show.tracks ?? [];
        return tracks.map((track) => trackItem(track, show));
      }
      case "track":
        throw new Error("Tracks are leaves, not browsable");
    }
  }

  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry && entry.expires > now) return entry.value;
    try {
      const value = await fetcher();
      this.cache.set(key, { value, expires: now + ONE_HOUR_MS });
      return value;
    } catch (error) {
      if (error instanceof PhishApiError && entry) return entry.value;
      throw error;
    }
  }
}

function container(id: string, title: string, subtitle?: string): SourceBrowseItem {
  return { id, title, kind: "container", subtitle };
}

function tourSlugFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || undefined;
}

function showItem(show: PhishShow): SourceBrowseItem {
  const venue = show.venue?.name ?? show.venue_name;
  const location = show.venue?.location;
  const subtitle = [venue, location].filter(Boolean).join(" · ");
  return {
    id: encodeId({ kind: "show", showId: show.date || String(show.id) }),
    title: show.date || `Show ${show.id}`,
    kind: "album",
    subtitle
  };
}

function trackItem(track: PhishTrack, show: PhishShow): SourceBrowseItem {
  const positionLabel = typeof track.position === "number" ? `${track.position}.` : "";
  const title = positionLabel ? `${positionLabel} ${track.title}` : track.title;
  return {
    id: encodeId({ kind: "track", trackId: String(track.id) }),
    title,
    kind: "playable",
    subtitle: track.set_name,
    artist: "Phish",
    album: showLabelFromShow(show),
    durationSeconds: typeof track.duration === "number" ? Math.round(track.duration / 1000) : undefined
  };
}

function showLabel(track: PhishTrack): string {
  const date = track.show?.date ?? track.show_date;
  const venue = track.show?.venue_name ?? track.venue_name;
  return [date, venue].filter(Boolean).join(" — ");
}

function showLabelFromShow(show: PhishShow): string {
  const venue = show.venue?.name ?? show.venue_name;
  return [show.date, venue].filter(Boolean).join(" — ");
}
