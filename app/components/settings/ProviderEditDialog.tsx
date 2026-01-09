"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Button,
  CloseButton,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Select,
  Spinner,
  Surface,
  TextField,
} from "@heroui/react";
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";

import { useAppTranslation } from "@/app/i18n/hooks";
import {
  type CreateProviderInput,
  useStorageSettings,
} from "@/app/hooks/useStorageSettings";
import {
  getDefaultApiUrlForProvider,
  BUILTIN_PROVIDER_ID,
  isBuiltinProviderEnabled,
} from "@/app/lib/config-utils";
import { extractSingleKey, normalizeSelection } from "@/app/lib/select-utils";
import { useToast } from "@/app/components/toast";
import type { ProviderConfig, ProviderType } from "@/app/types/chat";
import { createLogger } from "@/lib/logger";

interface ProviderEditDialogProps {
  isOpen: boolean;
  provider?: ProviderConfig | null;
  onClose: () => void;
  onSave: (provider: ProviderConfig) => void;
}

const logger = createLogger("ProviderEditDialog");

const defaultForm: CreateProviderInput = {
  displayName: "",
  providerType: "openai-compatible",
  apiUrl: getDefaultApiUrlForProvider("openai-compatible"),
  apiKey: "",
};

type EditableFieldKey = "displayName" | "providerType" | "apiUrl" | "apiKey";

const normalizeApiUrlForCompare = (value: string): string => {
  const trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "/") {
    end -= 1;
  }
  return trimmed.slice(0, end);
};

export function ProviderEditDialog({
  isOpen,
  provider,
  onClose,
  onSave,
}: ProviderEditDialogProps) {
  const { t } = useAppTranslation("settings");
  const { push } = useToast();
  const { addProvider, updateProvider } = useStorageSettings();
  const isBuiltin =
    isBuiltinProviderEnabled() && provider?.id === BUILTIN_PROVIDER_ID;

  const [formData, setFormData] = useState<CreateProviderInput>(defaultForm);
  const [errors, setErrors] = useState<{
    displayName?: string;
    providerType?: string;
    apiUrl?: string;
    apiKey?: string;
  }>({});
  const [isSaving, setIsSaving] = useState(false);

  const isFormValid = useMemo(
    () =>
      formData.displayName.trim().length >= 2 &&
      formData.apiUrl.trim().length > 0 &&
      Object.keys(errors).length === 0,
    [errors, formData.apiUrl, formData.displayName],
  );

  const resetState = useCallback(() => {
    if (provider) {
      setFormData({
        displayName: provider.displayName,
        providerType: provider.providerType,
        apiUrl: provider.apiUrl,
        apiKey: provider.apiKey,
      });
    } else {
      setFormData(defaultForm);
    }
    setErrors({});
    setIsSaving(false);
  }, [provider]);

  useEffect(() => {
    if (isOpen) {
      resetState();
    }
  }, [isOpen, resetState]);

  const handleFieldChange = useCallback(
    (field: EditableFieldKey, value: string) => {
      setFormData((prev) => {
        const next = { ...prev, [field]: value };

        // 当供应商类型变化时，自动更新 apiUrl（仅当此前仍为默认值或为空）
        if (field === "providerType") {
          const newType = value as ProviderType;
          const currentUrl = normalizeApiUrlForCompare(prev.apiUrl);
          const previousDefaultUrl = normalizeApiUrlForCompare(
            getDefaultApiUrlForProvider(prev.providerType),
          );
          const newDefaultUrl = getDefaultApiUrlForProvider(newType);

          // 仅当当前 URL 为空，或仍等于“旧类型默认 URL”时，才自动替换为新默认值
          if (!currentUrl || currentUrl === previousDefaultUrl) {
            next.apiUrl = newDefaultUrl;
          }
        }

        return next;
      });
      if (errors[field]) {
        setErrors((prev) => {
          const next = { ...prev };
          delete next[field];
          return next;
        });
      }
    },
    [errors],
  );

  const validateForm = useCallback((): boolean => {
    const nextErrors: typeof errors = {};

    if (!formData.displayName.trim()) {
      nextErrors.displayName = t("models.form.name.required");
    } else if (formData.displayName.length < 2) {
      nextErrors.displayName = t("models.form.name.minLength", { min: 2 });
    } else if (formData.displayName.length > 50) {
      nextErrors.displayName = t("models.form.name.maxLength", { max: 50 });
    }

    if (!formData.apiUrl.trim()) {
      nextErrors.apiUrl = t("models.form.apiUrl.required");
    } else {
      try {
        const url = new URL(formData.apiUrl);
        if (!url.protocol.startsWith("http")) {
          nextErrors.apiUrl = t("models.form.apiUrl.invalidProtocol");
        }
      } catch {
        nextErrors.apiUrl = t("models.form.apiUrl.invalid");
      }
    }

    if (formData.apiKey && formData.apiKey.length < 10) {
      nextErrors.apiKey = t("models.form.apiKey.minLength", { min: 10 });
    }

    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }, [formData.apiKey, formData.apiUrl, formData.displayName, t]);

  const handleSave = useCallback(async () => {
    if (!validateForm()) return;

    setIsSaving(true);
    try {
      const payload: CreateProviderInput = {
        displayName: formData.displayName.trim(),
        providerType: formData.providerType,
        apiUrl: formData.apiUrl,
        apiKey: formData.apiKey,
      };

      let saved: ProviderConfig;

      if (provider) {
        saved = await updateProvider(provider.id, payload);
        push({
          variant: "success",
          description: t("models.save.updateSuccess", {
            name: saved.displayName,
          }),
        });
      } else {
        saved = await addProvider(payload);
        push({
          variant: "success",
          description: t("models.save.createSuccess", {
            name: saved.displayName,
          }),
        });
      }

      onSave(saved);
      onClose();
    } catch (error) {
      logger.error("[ProviderEditDialog] 保存失败", error);
      push({ variant: "danger", description: t("models.save.error") });
    } finally {
      setIsSaving(false);
    }
  }, [
    addProvider,
    formData.apiKey,
    formData.apiUrl,
    formData.displayName,
    formData.providerType,
    onClose,
    onSave,
    provider,
    push,
    t,
    updateProvider,
    validateForm,
  ]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void handleSave();
    },
    [handleSave],
  );

  return (
    <ModalOverlay
      isOpen={isOpen}
      isDismissable
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/50 backdrop-blur-sm"
    >
      <AriaModal className="w-full max-w-lg px-4">
        <Surface className="w-full rounded-2xl bg-content1 p-4 shadow-2xl outline-none">
          <AriaDialog
            aria-label={
              provider ? t("models.editProvider") : t("models.addProvider")
            }
            className="flex flex-col gap-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">
                {provider ? t("models.editProvider") : t("models.addProvider")}
              </h2>
              <CloseButton aria-label={t("common.cancel")} onPress={onClose} />
            </div>

            <div>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <TextField isRequired isInvalid={Boolean(errors.displayName)}>
                  <Label>{t("models.form.name.label")}</Label>
                  <Input
                    value={formData.displayName}
                    onChange={(event) =>
                      handleFieldChange("displayName", event.target.value)
                    }
                    placeholder={t("models.form.name.placeholder")}
                  />
                  <Description>{t("models.form.name.description")}</Description>
                  {errors.displayName ? (
                    <FieldError>{errors.displayName}</FieldError>
                  ) : null}
                </TextField>

                <Select
                  isRequired
                  selectedKey={formData.providerType}
                  onSelectionChange={(keys) => {
                    const selection = normalizeSelection(keys);
                    const key = selection ? extractSingleKey(selection) : null;
                    if (typeof key === "string") {
                      handleFieldChange("providerType", key as ProviderType);
                    }
                  }}
                >
                  <Label>{t("models.form.type.label")}</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="openai-compatible">
                        OpenAI Compatible
                        <Description>
                          {t("models.form.type.options.openaiCompatible")}
                        </Description>
                      </ListBox.Item>
                      <ListBox.Item id="gemini">
                        Google Gemini
                        <Description>
                          {t("models.form.type.options.gemini")}
                        </Description>
                      </ListBox.Item>
                      <ListBox.Item id="anthropic">
                        Anthropic
                        <Description>
                          {t("models.form.type.options.anthropic")}
                        </Description>
                      </ListBox.Item>
                      <ListBox.Item id="deepseek-native">
                        DeepSeek Native
                        <Description>
                          {t("models.form.type.options.deepseekNative")}
                        </Description>
                      </ListBox.Item>
                      <ListBox.Item id="openai-reasoning">
                        OpenAI Reasoning
                        <Description>
                          {t("models.form.type.options.openaiReasoning")}
                        </Description>
                      </ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                  <Description>{t("models.form.type.description")}</Description>
                </Select>

                <TextField isRequired isInvalid={Boolean(errors.apiUrl)}>
                  <Label>{t("models.form.apiUrl.label")}</Label>
                  <Input
                    value={formData.apiUrl}
                    onChange={(event) =>
                      handleFieldChange("apiUrl", event.target.value)
                    }
                    placeholder={t("models.form.apiUrl.placeholder")}
                    isDisabled={isBuiltin}
                  />
                  <Description className="whitespace-pre-line">
                    {t("models.form.apiUrl.description")}
                  </Description>
                  {errors.apiUrl ? (
                    <FieldError>{errors.apiUrl}</FieldError>
                  ) : null}
                </TextField>

                <TextField isInvalid={Boolean(errors.apiKey)}>
                  <Label>
                    {t("models.form.apiKey.label")}
                    <span className="ml-2 text-sm text-default-500">
                      {t("common.optional")}
                    </span>
                  </Label>
                  <Input
                    type="password"
                    value={formData.apiKey}
                    onChange={(event) =>
                      handleFieldChange("apiKey", event.target.value)
                    }
                    placeholder={t("models.form.apiKey.placeholder")}
                    isDisabled={isBuiltin}
                  />
                  <Description>
                    {t("models.form.apiKey.description")}
                  </Description>
                  {errors.apiKey ? (
                    <FieldError>{errors.apiKey}</FieldError>
                  ) : null}
                </TextField>
              </form>
            </div>

            <div className="flex items-center justify-end gap-2">
              <Button variant="tertiary" onPress={onClose}>
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                onPress={handleSave}
                isDisabled={!isFormValid || isSaving}
              >
                {isSaving ? <Spinner size="sm" /> : null}
                {t("common.save")}
              </Button>
            </div>
          </AriaDialog>
        </Surface>
      </AriaModal>
    </ModalOverlay>
  );
}

export default ProviderEditDialog;
