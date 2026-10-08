# Apple Browning Grader

Offline web app (PWA) that grades browning of fresh-cut apple pieces from a phone photo.
Research prototype accompanying the study by Prasad P. et al. (manuscript in preparation).

- Finds the apple pieces (number set by the user), balances colour against nearby white paper (no grey card needed),
  converts to CIELAB and reports an image-derived ΔE*ab and level (0: <1.5, 1: 1.5-3, 2: 3-6, 3: >=6).
- Single-photo mode uses a ridge model trained on one apple photographed with three Android phones over 0-120 min.
- Comparison mode measures ΔE*ab directly against a fresh-cut photo of the same dish taken on the same phone.
- Everything runs on the phone; no photo leaves the device.

Limitations: trained on a single apple in one session; levels are image-derived, not colorimeter readings;
held-out-phone error of the single-photo estimate is about 2 ΔE units (see `model.json`, field `nested_lodo`).
