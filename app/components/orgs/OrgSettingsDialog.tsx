// components/dialogs/OrgSettingsDialog.tsx
import React, { useState } from "react";
import type { Org } from "../../lib/org/types";
import { updateOrgSettings } from "../../lib/org/client";
import { initials } from "./parts";
import { ErrorNote, Field, GhostButton, Modal, PrimaryButton, inputClass } from "../ui/Modal";
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
      setError(err instanceof Error ? err.message : "Failed to update settings");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Organisation settings" description="Manage how your organisation appears to your team." onClose={() => { if (!loading) onClose(); }} footer={<>
      <GhostButton onClick={onClose} disabled={loading}>Cancel</GhostButton>
      <PrimaryButton type="submit" form="organisation-settings" disabled={loading || !name.trim()}>
        {loading && <SpinnerIcon className="h-4 w-4" />} Save changes
      </PrimaryButton>
    </>}>
        <form id="organisation-settings" onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="organisation-logo" className="block text-sm font-medium text-vs-fg">
              Organisation logo
            </label>
            <div className="mt-2 flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-vs-border bg-vs-chrome text-lg font-semibold uppercase text-vs-fg">
                {imagePreview ? (
                  <img src={imagePreview} alt="Logo" className="h-full w-full object-cover" />
                ) : (
                  initials(name || "Org")
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <input
                  id="organisation-logo"
                  type="file"
                  accept="image/png, image/jpeg, image/webp"
                  onChange={handleImageChange}
                  className="w-full min-w-0 text-xs text-vs-muted file:mr-2 file:rounded-lg file:border-0 file:bg-vs-active file:px-3 file:py-2 file:text-sm file:font-medium file:text-vs-accent hover:file:opacity-90"
                />
                {imagePreview && (
                  <button
                    type="button"
                    onClick={() => setImagePreview(null)}
                    className="self-start rounded px-1 py-1 text-xs text-vs-danger hover:underline"
                  >
                    Remove logo
                  </button>
                )}
              </div>
            </div>
          </div>

          <Field label="Organisation name">
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputClass}
            />
          </Field>
          {error && <ErrorNote>{error}</ErrorNote>}
        </form>
    </Modal>
  );
}
