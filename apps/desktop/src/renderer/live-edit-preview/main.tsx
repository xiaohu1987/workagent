import ReactDOM from "react-dom/client";
import { LiveEditPreviewApp } from "./live-edit-preview-app";
import "../scroll-fades.css";
import { installScrollFades } from "../scroll-fades";

installScrollFades();
ReactDOM.createRoot(document.getElementById("root")!).render(<LiveEditPreviewApp />);
