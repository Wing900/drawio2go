"use client";

import { Button, Dropdown, Label } from "@heroui/react";
import {
  ChevronDown,
  FileDown,
  FileImage,
  Upload,
  FolderOpen,
  PanelRightClose,
  PanelRightOpen,
  Keyboard,
} from "lucide-react";
import { useAppTranslation } from "@/app/i18n/hooks";
import { ThemeToggle } from "./ThemeToggle";

interface TopBarProps {
  selectionLabel?: string;
  currentProjectName?: string;
  onOpenProjectSelector?: () => void;
  onLoad?: () => void;
  onSave?: () => void;
  onExportSVG?: () => void;
  isSidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export default function TopBar({
  selectionLabel,
  currentProjectName = "New Project",
  onOpenProjectSelector,
  onLoad,
  onSave,
  onExportSVG,
  isSidebarOpen,
  onToggleSidebar,
}: TopBarProps) {
  const { t } = useAppTranslation("topbar");

  return (
    <div className="top-bar">
      <div className="top-bar-selection" title={selectionLabel}>
        {selectionLabel || t("selectionLabel.noSelection")}
      </div>

      <div className="top-bar-center">
        {onOpenProjectSelector && (
          <Button
            variant="secondary"
            size="sm"
            className="top-bar-project"
            onPress={onOpenProjectSelector}
          >
            <FolderOpen size={16} />
            <span className="truncate">{currentProjectName}</span>
          </Button>
        )}
      </div>

      <div className="top-bar-actions">
        {onLoad && (
          <Button
            variant="secondary"
            size="sm"
            className="top-bar-button"
            onPress={onLoad}
          >
            <Upload className="h-4 w-4" />
            {t("buttons.load")}
          </Button>
        )}

        {(onSave || onExportSVG) && (
          <Dropdown>
            <Button variant="primary" size="sm" className="top-bar-button">
              <FileDown className="h-4 w-4" />
              {t("buttons.export")}
              <ChevronDown className="ml-0.5 h-4 w-4 opacity-70" />
            </Button>
            <Dropdown.Popover className="z-[1000] min-w-[180px]">
              <Dropdown.Menu
                disabledKeys={[
                  ...(onSave ? [] : ["export-drawio"]),
                  ...(onExportSVG ? [] : ["export-svg"]),
                ]}
                onAction={(key) => {
                  if (key === "export-drawio") {
                    onSave?.();
                  } else if (key === "export-svg") {
                    onExportSVG?.();
                  }
                }}
              >
                <Dropdown.Item id="export-drawio" textValue="export-drawio">
                  <FileDown className="h-4 w-4" />
                  <Label>
                    {t("buttons.exportDrawio", "导出为 .drawio 文件")}
                  </Label>
                </Dropdown.Item>
                <Dropdown.Item id="export-svg" textValue="export-svg">
                  <FileImage className="h-4 w-4" />
                  <Label>{t("buttons.exportSvg", "导出为 .svg 文件")}</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}

        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="top-bar-button"
          aria-label={t("aria.shortcuts")}
          onPress={() => window.open("/shortcuts-zh-CN.html", "_blank")}
        >
          <Keyboard size={18} />
        </Button>

        <ThemeToggle />

        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="top-bar-button"
          aria-label={
            isSidebarOpen ? t("aria.collapseSidebar") : t("aria.expandSidebar")
          }
          onPress={onToggleSidebar}
        >
          {isSidebarOpen ? (
            <PanelRightClose size={18} />
          ) : (
            <PanelRightOpen size={18} />
          )}
        </Button>
      </div>
    </div>
  );
}
