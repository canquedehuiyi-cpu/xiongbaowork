import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appConfig } from "./lib/generated/application-config";
import { queryClient } from "./query-client";
import { router } from "./router";
import "@copilotkit/react-core/v2/styles.css";
import "./styles.css";

// The tab says whose product this is. `index.html` carries the delivery brand before this runs;
// a custom tenant package supplies its own product name once the application starts.
document.title = appConfig.brand.productName;

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("OpenBot could not find the application root element.");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} context={{ queryClient }} />
    </QueryClientProvider>
  </StrictMode>,
);
