// components/dialogs/OrgSettingsDialog.tsx
import React, { useState } from "react";
import type { Org } from "../../lib/org/types";
import { updateOrgSettings } from "../../lib/org/client";
import { initials } from "./parts";
import { GhostButton, PrimaryButton } from "../ui/Modal";
import { SpinnerIcon } from "../icons";

export function OrgSettingsDialog({
  org,
  onClose,
  onUpdated,
}: {
  org: Org;
  onClose: () => void;
  onUpdated: (org: Org) => void;
}) {
  const [name, setName] = useState(org.name);
  const [imagePreview, setImagePreview] = useState<string | null>(org.image ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      setError("Image must be smaller than 2MB");
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      setImagePreview(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const updated = await updateOrgSettings(org.slug, {
        name: name.trim(),
        image: imagePreview,
      });
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Failed to update settings");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-vs-border bg-vs-panel p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-vs-fg">Organisation Settings</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-vs-muted">
              Org Logo / Image
            </label>
            <div className="mt-2 flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-vs-border bg-vs-chrome text-lg font-semibold uppercase text-vs-fg">
                {imagePreview ? (
                  <img src={imagePreview} alt="Logo" className="h-full w-full object-cover" />
                ) : (
                  initials(name || "Org")
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input
                  type="file"
                  accept="image/png, image/jpeg, image/webp"
                  onChange={handleImageChange}
                  className="text-xs text-vs-muted file:mr-2 file:rounded-md file:border-0 file:bg-vs-accent file:px-2.5 file:py-1 file:text-xs file:font-semibold file:text-vs-accent-fg hover:file:opacity-90"
                />
                {imagePreview && (
                  <button
                    type="button"
                    onClick={() => setImagePreview(null)}
                    className="self-start text-[11px] text-vs-danger hover:underline"
                  >
                    Remove logo
                  </button>
                )}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-vs-muted">
              Organisation Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-vs-border bg-vs-editor px-3 py-1.5 text-sm text-vs-fg focus:border-vs-accent focus:outline-none"
            />
          </div>

          {error && <p className="text-xs text-vs-danger">{error}</p>}

          <div className="mt-6 flex justify-end gap-2">
            <GhostButton type="button" onClick={onClose} disabled={loading}>
              Cancel
            </GhostButton>
            <PrimaryButton type="submit" disabled={loading || !name.trim()}>
              {loading && <SpinnerIcon className="mr-1.5 h-3.5 w-3.5" />}
              Save Changes
            </PrimaryButton>
          </div>
        </form>
      </div>
    </div>
  );
}
