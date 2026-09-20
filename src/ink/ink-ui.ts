import EBUS from "../event-bus";
import { IMGFetcherQueue } from "../fetcher-queue";
import { Chapter } from "../page-fetcher";
import { Elements } from "../ui/html";
import { i18n } from "../utils/i18n";
import { InkTranslateService } from "./ink-translate";

export function initInkTranslateUI(HTML: Elements, IFQ: IMGFetcherQueue, chapters: () => Chapter[]): InkTranslateService {
  const service = new InkTranslateService(IFQ, index => chapters()[index]);
  HTML.inkTranslateBTN.addEventListener("click", () => {
    if (service.status === "running") service.cancel();
    else service.start();
  });
  EBUS.subscribe("ink-progress", () => {
    const { done, total } = service.progress;
    HTML.inkTranslateBTN.textContent = service.status === "running"
      ? i18n.inkTranslating.get().replace("{0}", String(done)).replace("{1}", String(total))
      : service.status === "done" ? i18n.inkTranslated.get() : i18n.inkTranslate.get();
    HTML.inkTranslateBTN.setAttribute("aria-busy", String(service.status === "running"));
  });
  EBUS.subscribe("pf-change-chapter", () => service.cancel());
  return service;
}
