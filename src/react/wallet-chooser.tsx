"use client";

import type { CSSProperties, ReactNode } from "react";
import type { WalletChooserState } from "@/react/use-wallet-chooser";
import type { WalletCandidate } from "@/wallets/descriptor";

export interface WalletChooserProps {
  chooser: WalletChooserState;
  /** Shown above the rows. Defaults by action. */
  title?: ReactNode;
  className?: string;
  /** Text for a row that is installed / not installed. */
  labels?: { connect?: ReactNode; install?: ReactNode; recommended?: ReactNode };
}

const row: CSSProperties = { display: "flex", alignItems: "center", gap: "0.75rem" };
const icon: CSSProperties = { width: "2rem", height: "2rem", borderRadius: "0.5rem", flex: "none" };
const grow: CSSProperties = { flex: 1, minWidth: 0 };

function Icon({ candidate }: { candidate: WalletCandidate }) {
  if (candidate.icon)
    return <img src={candidate.icon} alt="" style={icon} className="xcp-wallet-chooser__icon" />;
  return (
    <span
      aria-hidden
      style={{ ...icon, display: "grid", placeItems: "center" }}
      className="xcp-wallet-chooser__icon"
    >
      {candidate.name.charAt(0)}
    </span>
  );
}

/**
 * The rows of a wallet chooser: one per supported wallet, recommended first.
 * Installed wallets connect; the rest link to their store. The dialog, its
 * styling and its dismissal belong to the site; class names are provided for CSS.
 */
export function WalletChooser({ chooser, title, className, labels }: WalletChooserProps) {
  const heading = title ?? (chooser.action === "install" ? "Get a wallet" : "Choose a wallet");
  return (
    <div className={["xcp-wallet-chooser", className].filter(Boolean).join(" ")}>
      <div className="xcp-wallet-chooser__title">{heading}</div>
      <ul className="xcp-wallet-chooser__list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {chooser.candidates.map((candidate, index) => (
          <li key={candidate.id} className="xcp-wallet-chooser__row" style={row}>
            <Icon candidate={candidate} />
            <span style={grow} className="xcp-wallet-chooser__name">
              {candidate.name}
              {index === 0 && (
                <span className="xcp-wallet-chooser__badge"> {labels?.recommended ?? "Recommended"}</span>
              )}
            </span>
            {candidate.installed ? (
              <button
                type="button"
                className="xcp-wallet-chooser__connect"
                onClick={() => void chooser.choose(candidate.id)}
              >
                {labels?.connect ?? "Connect"}
              </button>
            ) : (
              <a
                className="xcp-wallet-chooser__install"
                href={candidate.installUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {labels?.install ?? "Install"}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
