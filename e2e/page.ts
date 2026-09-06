import { WalletSession } from "@/session";
import { verifyBip322 } from "@/crypto/bip322";
import { verifyDeclaredConnectionSignature } from "@/provider/proof";
import { discoverWallets, webSessionOptions } from "@/web";

/** The page under test: a session started with the web defaults, everything on `window.sdk`. */
const discovery = discoverWallets();
const session = new WalletSession({ ...webSessionOptions(), wallets: discovery });
session.start();

Object.assign(window, { sdk: { session, discovery, verifyBip322, verifyDeclaredConnectionSignature } });
