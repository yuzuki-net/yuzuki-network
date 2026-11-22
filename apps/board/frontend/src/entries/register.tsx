import { ToastProvider } from "@cloudflare/kumo/components/toast";
import Register from "../pages/register";
import { mountPublic } from "./public";

mountPublic(<ToastProvider><Register /></ToastProvider>);
