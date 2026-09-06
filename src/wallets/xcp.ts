import { WalletSdkError } from "@/errors";
import type { XcpProvider } from "@/provider/types";
import type { WalletDescriptor } from "@/wallets/descriptor";
import { registeredProvider } from "@/wallets/registry";

declare global {
  interface Window {
    xcpwallet?: XcpProvider;
  }
}

/** The extension dispatches this once injected, and again on `XCP_DISCOVER_EVENT`. */
export const XCP_INITIALIZED_EVENT = "xcp-wallet#initialized";
export const XCP_DISCOVER_EVENT = "xcp-wallet#discover";

export const XCP_WALLET_INSTALL_URL =
  "https://chromewebstore.google.com/detail/xcp-wallet/nicpjdbehgcjbjfjkobcidnfmfpijohg";

const XCP_WALLET_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAPnSURBVGhD7ZhJaBRBFIanJzF6UBGdRFHBm6KoRBA9qIgGJTloElFccMnFiDcPxhVNohET3MGTMS6IJl6yXFSECIKCZyUuKO5e0gF3ULOM/99VM5nuqerumUi81Ac/773q7ur3uruWmYjBYDAYDAZD9ljS+tKTX5YHMxKKOw1urJjd/l36oUB/o6Xrhfn0or9fIgwmsADcrAjmPMSbDrDNwwjoEXqqiHW3fxNNauz88jwrEm+EuwLqdRrdRKHfUBWKaHNaAvAtQCbfDumeWCqd6K0MRfyQsQskn4vkm+GuFS2+sLgNKKJVhHpYsRIkvxyGTyFM8qQIH1grrhsr4yR2QWkmyRO+1Rb0VS5CPcoCcOEyGD75MU5DePhpnBGuwEk+bt2AGzb5BIkiykSoJq0AmXwHlGnyCWxpmXwOkr8Od51oyRhOHjf9inCNAZw4H6YTSvsMJByk74XrPKEZwk1y0eqLVk743Bq3JyL5ASf59eKQklcQZxzOblOg8ZCKP1AJxsQ9EQ7ifQPFkC75N9ASdDIHtjBixWfB7uIBSROObZfJR5H8NbT5JV+DvGfCFuK6ubALoSc8oIBvolS4brwFqOZ58hriE3jMALY/1t0xAHsO4UZoN17mDh5LSZ7tOmpwbW3M7uhjX2yA5dsogXRFqKbw0AVU4wYvpO8C7S3QqZjd1m9PWs3kr6J5kziq5AjOr5W+C7R/gtkronAoZyEFX6TV0j15lWX1R6/A3SxalBxFktXS1/FV2lCELUD3ZpJEe3OY/BYRKalD8oel70fgvVIJW4B3tnGB2esyzFYRKWHyh6QfxHRpQ+EtQLe1qEOSylkA7ZdgKkSk5FgieZw7DmqGGnsKSrk5dIF2rkFnRZSGMjfvOrAHpkFEaXC+roQeQDkQiz8AbYN0HEfyPMdJHoar+1LGgNuUgxD3PZyJ5kFNEM9TcRJ9VUk/ibcALiZ3oNlOg5rEVpdFcDHTUY8b7qeDfrlAcXVfzDiFPikySloVb6GV6O+lCAdJey242VSY25BfEUE04Gb76KA/Loy3oEWMs4DJF6M/5TSeNohx4kcYLihdTkPmnEgkL1kAZZv8O4gLqDJ5opyFUop46jSEh98px1EqYWc6L9xzMfnnIlSj7RwXfoDh3ihsEadxTdogAxnN6xI+eX42z0SoRzdtJsE3PA2mDuJAVO1HcqH7uFm9CN3gev5GuCsiF5x5HkJc5RMPkvn8hLhXCkyeBBYwVHwKaEOSa6SfNdl+n/8CfqJDZjgK0L1lfnpDZjgK0P3HE/q/Hz+GYwxwz7MT4mTAgct78ifiBYwB/sozGAwGg8Fg+D9EIn8BnbIl6I1ut4oAAAAASUVORK5CYII=";

export const XCP_WALLET: WalletDescriptor = {
  id: "xcp",
  name: "XCP Wallet",
  icon: XCP_WALLET_ICON,
  installUrl: XCP_WALLET_INSTALL_URL,
  registryId: "XcpWalletProvider",
  // Builds from 0.11.1 register themselves; the injected object covers the ones before.
  installed: () =>
    typeof window !== "undefined" &&
    (window.xcpwallet !== undefined || registeredProvider("XcpWalletProvider") !== null),
  provider: () => {
    const provider = typeof window === "undefined" ? undefined : window.xcpwallet;
    if (!provider) throw new WalletSdkError("wallet_missing", "XCP Wallet not detected");
    return provider;
  },
  onInjected: (listener) => {
    if (typeof window === "undefined") return () => {};
    const handler = () => {
      if (window.xcpwallet) listener();
    };
    window.addEventListener(XCP_INITIALIZED_EVENT, handler);
    window.dispatchEvent(new Event(XCP_DISCOVER_EVENT));
    return () => window.removeEventListener(XCP_INITIALIZED_EVENT, handler);
  },
  nudge: () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event(XCP_DISCOVER_EVENT));
  },
};
