"""Translation using TranslateGemma via mlx-lm.

Runs natively on Apple Silicon (MLX/Metal). Lazy-loads on first use
so the MLX GPU stream stays on the calling thread.
"""

import logging
import time

log = logging.getLogger(__name__)

# ISO 639-1 → full language name for TranslateGemma prompt
LANG_NAMES = {
    "af": "Afrikaans", "ar": "Arabic", "bg": "Bulgarian", "bn": "Bengali",
    "ca": "Catalan", "cs": "Czech", "da": "Danish", "de": "German",
    "el": "Greek", "en": "English", "es": "Spanish", "et": "Estonian",
    "fi": "Finnish", "fr": "French", "gl": "Galician", "gu": "Gujarati",
    "he": "Hebrew", "hi": "Hindi", "hr": "Croatian", "hu": "Hungarian",
    "id": "Indonesian", "it": "Italian", "ja": "Japanese", "ka": "Georgian",
    "kk": "Kazakh", "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian",
    "mk": "Macedonian", "ml": "Malayalam", "mr": "Marathi", "ms": "Malay",
    "nl": "Dutch", "no": "Norwegian", "pl": "Polish", "pt": "Portuguese",
    "ro": "Romanian", "ru": "Russian", "sk": "Slovak", "sl": "Slovenian",
    "sr": "Serbian", "sv": "Swedish", "sw": "Swahili", "ta": "Tamil",
    "te": "Telugu", "th": "Thai", "tl": "Filipino", "tr": "Turkish",
    "uk": "Ukrainian", "ur": "Urdu", "vi": "Vietnamese", "zh": "Chinese",
}


class Translator:
    """TranslateGemma-based translation running on MLX/Metal."""

    def __init__(self, model_name="mlx-community/translategemma-4b-it-4bit_immersive-translate"):
        self.model_name = model_name
        self.model = None
        self.tokenizer = None

    def _ensure_loaded(self):
        """Lazy-load on first use so MLX stream is on the calling thread."""
        if self.model is None:
            log.info(f"Loading translation model: {self.model_name}")
            t0 = time.monotonic()
            from mlx_lm import load
            self.model, self.tokenizer = load(self.model_name)
            log.info(f"Translation model loaded in {time.monotonic() - t0:.1f}s")

    def translate(self, text, source_lang, target_lang):
        """Translate text from source_lang to target_lang.

        Args:
            text: Text to translate.
            source_lang: ISO 639-1 code (e.g. "fr").
            target_lang: ISO 639-1 code (e.g. "en").

        Returns:
            Translated string, or None on failure.
        """
        if not text or not text.strip():
            return None

        self._ensure_loaded()

        source_name = LANG_NAMES.get(source_lang, source_lang)
        target_name = LANG_NAMES.get(target_lang, target_lang)

        # Build the immersive-translate marker content
        content = f"<<<source>>>{source_name}<<<target>>>{target_name}<<<text>>>{text.strip()}"

        # Apply chat template so model gets the proper instruction prompt
        messages = [{"role": "user", "content": content}]
        prompt = self.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False
        )

        try:
            import re
            from mlx_lm import generate
            t0 = time.monotonic()
            result = generate(
                self.model,
                self.tokenizer,
                prompt=prompt,
                max_tokens=len(text.split()) * 3,  # generous upper bound
                verbose=False,
            )
            elapsed = time.monotonic() - t0
            result = result.strip()
            log.debug(f"Raw translation output: {result[:300]}")

            # Strip any <<< tags the model might still emit
            result = re.split(r"<<<\w+>>>", result)[0].strip()

            if not result:
                log.warning("Translation returned empty result")
                return None

            log.info(f"Translation ({source_lang}→{target_lang}): {elapsed:.2f}s | "
                     f"{len(text.split())} words → {len(result.split())} words")
            return result
        except Exception as e:
            log.warning(f"Translation error: {e}")
            return None


def create_translator(config):
    """Create a Translator if enabled. Returns None if disabled."""
    if config.get("TRANSLATE", "true").lower() in ("0", "false", "no"):
        log.info("Translation disabled via config")
        return None

    try:
        model_name = config.get(
            "TRANSLATE_MODEL",
            "mlx-community/translategemma-4b-it-4bit_immersive-translate",
        )
        return Translator(model_name=model_name)
    except Exception as e:
        log.warning(f"Failed to create translator: {e}")
        return None
