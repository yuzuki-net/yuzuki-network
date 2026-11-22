import { ToastProvider } from "@cloudflare/kumo/components/toast";
import Login from "../pages/login";
import { mountPublic } from "./public";

mountPublic(<ToastProvider><Login /></ToastProvider>);
