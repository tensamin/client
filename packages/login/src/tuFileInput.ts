import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

export function useTuFileInput(
  onFile: (file: globalThis.File) => Promise<void>,
  disabled = false,
) {
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);

  const openFilePicker = useCallback(() => {
    if (disabled || filePickerOpen || !uploadRef.current) return;

    flushSync(() => setFilePickerOpen(true));
    requestAnimationFrame(() => {
      setTimeout(() => uploadRef.current?.click(), 0);
    });
  }, [disabled, filePickerOpen]);

  const handleFileInputChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      setFilePickerOpen(false);
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || disabled) return;
      await onFile(file);
    },
    [disabled, onFile],
  );

  useEffect(() => {
    const input = uploadRef.current;
    const closeFilePicker = () => setFilePickerOpen(false);
    input?.addEventListener("cancel", closeFilePicker);
    return () => input?.removeEventListener("cancel", closeFilePicker);
  }, []);

  useEffect(() => {
    let dragCounter = 0;
    const stop = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const handleDragEnter = (event: DragEvent) => {
      stop(event);
      if (disabled) return;
      dragCounter += 1;
      if (event.dataTransfer?.items?.length) setIsDragging(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      stop(event);
      dragCounter -= 1;
      if (dragCounter <= 0) setIsDragging(false);
    };
    const handleDragOver = (event: DragEvent) => {
      stop(event);
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    };
    const handleDrop = (event: DragEvent) => {
      stop(event);
      dragCounter = 0;
      setIsDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (file && !disabled) void onFile(file);
    };

    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragenter", handleDragEnter);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("drop", handleDrop);
    };
  }, [disabled, onFile]);

  return {
    handleFileInputChange,
    isDragging,
    openFilePicker,
    filePickerOpen,
    uploadRef,
  };
}
