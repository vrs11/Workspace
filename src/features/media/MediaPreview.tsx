import * as Menu from "@radix-ui/react-dropdown-menu";
import { SlidersHorizontal, Check } from "lucide-react";
import ImagePreview from "./ImagePreview";
import { loadDocument } from "../editor/models";
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Media } from "../../generated/protocol";
import { reloadMedia } from "./session";
import { useApp, perform, notice } from "../../shared/state/store";

export default function MediaPreview({ media }: { media: Media }) {
  const [error, setError] = useState("");
  const [dimensions, setDimensions] = useState("");
  const [zoom, setZoom] = useState("fit");
  const [rendering, setRendering] = useState<"pixels" | "smooth">("smooth");
  const vector = media.mime === "image/svg+xml";
  const section = useRef<HTMLElement>(null);
  const playback = useRef<HTMLMediaElement | null>(null);
  const scope = useApp.getState().project!.id;
  const reloads = useRef(new Set<string>());
  const [reloading, setReloading] = useState<string | null>(null);
  const url = `${convertFileSrc("", "workspace-media")}${scope}/${media.token}`;
  useEffect(() => {
    if (
      !document.querySelector('.dialog-content[role="dialog"], [role="menu"]')
    )
      section.current?.focus();
    setError("");
    setDimensions("");
    const player = playback.current;
    return () => {
      if (player) {
        player.pause();
        player.removeAttribute("src");
        player.load();
      }
    };
  }, [media.token]);
  useEffect(() => {
    const command = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (!id.startsWith("media.")) return;
      event.preventDefault();
      const player = playback.current;
      if (id === "media.fit") {
        setZoom("fit");
        return;
      }
      if (id === "media.zoomIn" || id === "media.zoomOut") {
        setZoom((old) =>
          String(
            Math.min(
              32,
              Math.max(
                0.02,
                (old === "fit" ? 1 : Number(old)) *
                  (id === "media.zoomIn" ? 2 : 0.5),
              ),
            ),
          ),
        );
        return;
      }
      if (!player) {
        notice("Playback controls are available for audio and video previews.");
        return;
      }
      switch (id) {
        case "media.playPause":
          if (player.paused)
            void player
              .play()
              .catch(() =>
                setError(
                  "Playback could not start. Use the player controls or try a supported codec.",
                ),
              );
          else player.pause();
          break;
        case "media.seekBack":
          player.currentTime = Math.max(0, player.currentTime - 5);
          break;
        case "media.seekForward":
          if (Number.isFinite(player.duration))
            player.currentTime = Math.min(
              player.duration,
              player.currentTime + 5,
            );
          break;
        case "media.mute":
          player.muted = !player.muted;
          break;
        case "media.volumeUp":
          player.volume = Math.min(1, player.volume + 0.1);
          break;
        case "media.volumeDown":
          player.volume = Math.max(0, player.volume - 0.1);
          break;
      }
    };
    window.addEventListener("workspace-command", command);
    return () => window.removeEventListener("workspace-command", command);
  });
  const fail = () =>
    setError(
      "This file could not be decoded by your system WebView. It may use an unsupported codec or be damaged. Try another format, or reload if the file changed.",
    );
  return (
    <section
      ref={section}
      tabIndex={0}
      className="media-preview"
      aria-label={`Media preview ${media.name}`}
    >
      <div className="media-toolbar">
        <span className="truncate" title={media.path}>
          {media.name}
        </span>
        <small>
          {media.mime} · {(media.size / 1024 / 1024).toFixed(2)} MiB{" "}
          {dimensions && `· ${dimensions}`}
        </small>
        <div className="header-spacer" />
        {media.kind === "image" && (
          <label>
            Zoom{" "}
            <select
              aria-label="Image zoom"
              title={
                vector
                  ? "100% uses the SVG intrinsic size"
                  : "100% maps one image pixel to one display pixel"
              }
              value={zoom}
              onChange={(e) => setZoom(e.target.value)}
            >
              {zoom !== "fit" && !["0.5", "1", "2"].includes(zoom) && (
                <option value={zoom}>{Math.round(Number(zoom) * 100)}%</option>
              )}
              <option value="fit">Fit</option>
              <option value="1">100%</option>
              <option value="0.5">50%</option>
              <option value="2">200%</option>
            </select>
          </label>
        )}
        {media.kind === "image" && !vector && (
          <Menu.Root>
            <Menu.Trigger asChild>
              <button aria-label="Image rendering" title="Image rendering">
                <SlidersHorizontal size={15} />
              </button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="dock-menu" sideOffset={4}>
                <Menu.Label>Image rendering</Menu.Label>
                <Menu.RadioGroup
                  value={rendering}
                  onValueChange={(value) =>
                    setRendering(value === "smooth" ? "smooth" : "pixels")
                  }
                >
                  <Menu.RadioItem value="pixels">
                    <Menu.ItemIndicator>
                      <Check size={12} />
                    </Menu.ItemIndicator>
                    Source pixels
                  </Menu.RadioItem>
                  <Menu.RadioItem value="smooth">
                    <Menu.ItemIndicator>
                      <Check size={12} />
                    </Menu.ItemIndicator>
                    Smooth scaling
                  </Menu.RadioItem>
                </Menu.RadioGroup>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
        {media.mime === "image/svg+xml" && (
          <button
            onClick={() =>
              void perform(() => loadDocument(media.entry, true, true))
            }
          >
            Open as code
          </button>
        )}
        <button
          disabled={reloading === media.entry}
          onClick={() => {
            const entry = media.entry;
            if (reloads.current.has(entry)) return;
            reloads.current.add(entry);
            setReloading(entry);
            void perform(async () => {
              try {
                await reloadMedia(entry);
              } finally {
                reloads.current.delete(entry);
                setReloading((current) => (current === entry ? null : current));
              }
            });
          }}
        >
          Reload preview
        </button>
      </div>
      {error ? (
        <div className="empty-state" role="alert">
          {error}
        </div>
      ) : (
        <div
          className={`media-content ${media.kind === "image" ? "media-image" : "media-fit"}`}
        >
          {media.kind === "image" ? (
            <ImagePreview
              key={media.token}
              vector={vector}
              rendering={rendering}
              src={url}
              name={media.name}
              zoom={zoom}
              onZoom={setZoom}
              onError={fail}
              onLoad={(size) => setDimensions(`${size.width} × ${size.height}`)}
            />
          ) : media.kind === "video" ? (
            <video
              key={media.token}
              ref={(node) => {
                playback.current = node;
              }}
              src={url}
              controls
              preload="metadata"
              playsInline
              onError={fail}
              onLoadedMetadata={(e) =>
                setDimensions(
                  `${e.currentTarget.videoWidth} × ${e.currentTarget.videoHeight}`,
                )
              }
            />
          ) : (
            <div className="audio-preview">
              <p>{media.name}</p>
              <audio
                key={media.token}
                ref={(node) => {
                  playback.current = node;
                }}
                src={url}
                controls
                preload="metadata"
                onError={fail}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
