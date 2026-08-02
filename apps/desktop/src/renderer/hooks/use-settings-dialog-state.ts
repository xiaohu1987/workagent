import { useState } from "react";
import type { CapabilityTab, SettingsTab } from "../core/app-types";

export function useSettingsDialogState() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("provider");
  const [capabilityTab, setCapabilityTab] = useState<CapabilityTab>("skills");

  return {
    isSettingsOpen,
    setIsSettingsOpen,
    settingsTab,
    setSettingsTab,
    capabilityTab,
    setCapabilityTab
  };
}
