import { createContext } from "preact";
import { useContext } from "preact/hooks";

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  requireText?: string;
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

export const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false));

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}
