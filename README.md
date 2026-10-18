# See Food

"Hotdog" / "Not hotdog" classification using [LiquidAI's d1-3B](AtomicChat/d1-3B-GGUF) local decision model in LM Studio. Built with Vanilla HTML, CSS, and JavaScript with a Python standard-library backend; no external dependencies or build step required. Requires Python 3.10+.

![See Food showing the default screen and the illuminated Local AI sign](./screenshot.png)

## 1. Prepare LM Studio

1. Load **d1-3b** with its vision adapter / multimodal projector. A text-only model cannot inspect photos.
2. Start the LM Studio server in the Developer tab. The default address is `http://localhost:1234`.
3. Keep LM Studio local-only. You do **not** need CORS or LM Studio's “Serve on Local Network” option: the Python app bridges phone requests to it.

The app uses `POST /v1/systemone` with an inline JPEG and a typed choice question. It accepts only `hotdog` or `not_hotdog`. See [LM Studio System One documentation](https://lmstudio.ai/docs/developer/jev-compat/systemone).

## 2. Run on this computer

From this folder in PowerShell:

```powershell
python .\src\server.py
```

Open `http://localhost:8000`.

Opening the HTML file directly or using a static-only server will not run the backend. Upload a photo and select **Is it a hotdog?**. The result replaces the classify action with **Try another photo**; errors offer **Retry**. The crossed-out hotdog icon accompanies a negative verdict - "Not hotdog". On touch-first devices, **Take a photo** is the primary photo action; desktop prioritizes upload. The radio-style **Local AI** sign lights up **ON AIR · READY** when LM Studio reports the configured decision model loaded with vision support. It dims to **OFF AIR** when unavailable/unloaded and shows **ANALYZING** while this app is running inference. It checks `/api/v1/models` through the backend on page load and every 10 seconds while the page is visible; no inference is run and no model is auto-loaded by these checks. Returning to the tab refreshes status. Upload, camera, drag-and-drop, photo replacement, and analysis are blocked until the sign reports ready. A failed or pending check displays an explanatory notice, and controls re-enable automatically on recovery. If readiness is lost after choosing a photo, the preview is retained but cannot be analyzed until readiness returns. In-progress analysis is allowed to finish. This is a metadata readiness check, not a guarantee that inference will succeed or that LM Studio is idle for other applications.

Stop with Ctrl+C.

If your model identifier or LM Studio port differs:

```powershell
python .\src\server.py --model d1-3b --lm-url http://localhost:1234
```

If LM Studio authentication is enabled, set `LM_STUDIO_API_KEY` in the server's environment before starting it. Never put the key in browser code or commit it. `LM_STUDIO_URL` and `LM_STUDIO_MODEL` can also supply defaults. Only loopback HTTP LM Studio addresses are accepted.

## 3. Use your phone over Wi-Fi

```powershell
python .\src\server.py --host 0.0.0.0
```

- Use a trusted **private** Wi-Fi network; connect both devices to the same network.
- Open the printed `http://<computer-IP>:8000` phone address on your phone, not `localhost`. If multiple addresses appear, use the Wi-Fi adapter's IPv4 address shown by `ipconfig`.
- If Windows Firewall prompts, allow Python on **Private networks only**, never Public. Do not disable the firewall. If needed, allow inbound TCP port 8000 only on the Private profile.
- Guest Wi-Fi/client isolation or a VPN may block phone-to-computer traffic.
- Do not forward this port on your router. This lightweight server has no user authentication or HTTPS and is intended only for a trusted home LAN, not internet hosting. Wi-Fi image requests use unencrypted HTTP.
- **Take a photo** requests the rear camera through the mobile file picker. Browser/device support varies; the photo library fallback still works. This does not use `getUserMedia`, which requires HTTPS away from localhost.

## Images and privacy

Images up to 15 MB are decoded in the browser, resized to a maximum 1280-pixel edge, flattened onto white, and re-encoded as JPEG. This supports browser-decodable formats and strips original metadata from the transmitted image. Unsupported HEIC files should be converted to JPEG first. Animated images are classified from one rendered frame.

The prepared photo travels to the Python server on your computer, then to LM Studio on that same computer. The app does not persist images, filenames, or model responses, and serves only its three frontend files. Check LM Studio's own logging/storage settings separately. Google Fonts makes optional typography requests, but receives no photos; system fonts work offline.

The model can make mistakes, especially for unusual foods or ambiguous photos...like a person wearing a hotdog costume. Only one inference is allowed at a time; additional requests receive a busy error. Changing a photo cancels the browser request and ignores stale results, but inference already running inside LM Studio may finish before the next request can run. Requests time out after approximately two minutes.

## Troubleshooting

- **Cannot reach LM Studio:** start its server; verify the address and model.
- **LM Studio rejected the image request:** check the LM Studio logs, D1 selection, and loaded vision adapter; update LM Studio if `/v1/systemone` is unavailable.
- **Authentication error:** configure `LM_STUDIO_API_KEY` on the Python server if you have it enabled in LM Studio.
- **Timeout:** wait for model loading, try a smaller image, or check available memory in LM Studio.
- **Phone cannot connect:** check the Wi-Fi IPv4 address, Private firewall rule, and network isolation. Keep the computer awake.

## Tests

```powershell
python -m unittest discover -s tests -v
```

Tests use a mocked model for request validation, strict result parsing, offline errors, cross-origin/host checks, static-file restrictions, and concurrency. Real classification additionally requires the running LM Studio model.

Original interface and assets; not affiliated with Silicon Valley or its creators.
