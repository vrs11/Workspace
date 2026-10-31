import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useApp } from "../state/store";
import { ErrorDetails } from "./ErrorDetails";

export function NotificationToast() {
  const message = useApp((state) => state.notice);
  const details = useApp((state) => state.noticeDetails);
  return createPortal(
    <div
      className={`notification-toast${message ? " notice" : ""}`}
      hidden={!message}
      role="region"
      aria-label="Notifications"
    >
      <span className="notification-message" role="alert" aria-atomic="true">
        {message}
      </span>
      {/* Keep an open details dialog alive when a background notice clears. */}
      <ErrorDetails details={details} />
      <button
        type="button"
        className="notification-dismiss"
        aria-label="Dismiss notification"
        title="Dismiss notification"
        onClick={() => useApp.getState().set({ notice: "" })}
      >
        <X size={14} />
      </button>
    </div>,
    document.body,
  );
}
