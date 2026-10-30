# RiverField sur cette machine (installation locale)

RiverField tourne par-dessus **ton** ComfyUI ROCm, pas sur Modal.

| | |
|---|---|
| ComfyUI | `/home/zardoz/comfyui-vanilla-gfx1151/ComfyUI` (0.42.0, gfx1151) |
| venv | `/home/zardoz/comfyui-vanilla-gfx1151/.venv-r101` (torch 2.14 + ROCm 10.1) |
| Modèles | `ComfyUI/models` (les tiens) |
| Backend | `:8188` ComfyUI · `:8189` comfy-api-proxy · `:8000` gateway |
| Web | `:3000` |
| Dossier | `/home/zardoz/riverfield` |

## Démarrer

```sh
cd ~/riverfield
./run-backend.sh        # terminal 1 : ComfyUI + proxy + gateway (Ctrl+C arrête tout)
./run-web.sh            # terminal 2 : http://127.0.0.1:3000
```

En ligne de commande, sans navigateur :

```sh
npm run apps                                            # liste des 120 apps
npm run app -- create-image --set prompt="..."          # une génération
npm run app -- video --file image=photo.jpg --set duration=5
```

## Ce qui a été adapté à cette machine

1. **`run-backend.sh`** reprend le venv et les flags de `15_RUN_COMFYUI_ROCM101.sh`
   (`--dont-upcast-attention --cache-none`) et ajoute `--use-split-cross-attention` :
   sur ROCm 10.1 / gfx1151, le SDPA plante sur l'encodeur **gemma4-12b de LTX-2.5**
   (`hipErrorProfilerNotInitialized`). L'attention découpée évite ce noyau.
   Coût mesuré sur create-image : 70,6 s contre 71,1 s → négligeable.
   Ton propre script `15_RUN...` n'est pas modifié : tes lancements habituels gardent
   l'attention PyTorch par défaut.

2. **Liens symboliques** (aucun octet redownloadé) dans `ComfyUI/models` :
   - `diffusion_models/flux3-image-klein-int8-convrot.safetensors`
     → `flux3_image_klein_sd_int8_convrot.safetensors` (même fichier que sur HF)
   - `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_w4a8.safetensors`
     → `qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors`
     (même modèle, quant int8 au lieu de w4a8 : +3 Go de VRAM, sortie correcte)
   - `diffusion_models/minimax_music3_dit_fp16.safetensors`
     → `minimax_music3_dit_int8_convrot.safetensors`

3. **Noeuds custom ajoutés** à `ComfyUI/custom_nodes` :
   - `ComfyUI-LTXVideo` @ 44c8a36 (Lightricks) — apps vidéo LTX/VFX
   - `ComfyUI-CrossViewWarp` @ fbb1e93 — app `reshoot`
   - deps installées en `--no-deps` : `colour-science`, `openimageio`, `ninja`
     (torch / transformers / diffusers intacts)

## Apps turbo MiniMax H3 (locales, survivent aux `git pull`)

Quatre clones des apps H3, avec un LoRA turbo et les réglages qui vont avec ; les apps
d'origine restent intactes :

| App | LoRA | steps / sampler | base |
|---|---|---|---|
| `h3-video-turbo` | `taomate_h3_3step_comfy` 1.0 | 3 / `euler` | `h3-video` (20 / `res_multistep`) |
| `h3-photo-turbo` | idem | 3 / `euler` | `h3-photo` |
| `extend-video-turbo` | idem | 3 / `euler` | `extend-video` |
| `reshoot-turbo` | `minimax_h3_ref2v_turbo_4step_v0.1` (remplace le 8-step) | 4 / `euler` | `reshoot` (8 steps) |

Elles sont **hors git** : les dossiers `apps/*-turbo/` et `local/` sont listés dans
`.git/info/exclude` (fichier local, non versionné), donc un `git pull` ne les touche jamais
et `git status` reste propre.

De plus `h3-video-turbo` et `h3-photo-turbo` ont un **sélecteur de résolution en
mégapixels**, branché sur le `ResolutionSelector` / l'`ImageScaleToTotalPixels`
du workflow — exactement le réglage que ComfyUI expose. `extend-video-turbo` et
`reshoot-turbo` n'en ont pas : la taille y vient du clip d'entrée.

Plafond mesuré sur cette machine (112 Go) : **0.4 / 0.6 / 0.8 MP**. À 1,0 MP le run passe
mais devient très lent (14 min sans finir pour 2 s), et à 1,5 MP c'est un OOM
(`Tried to allocate 69.73 GiB`). C'est l'attention non-flash de ROCm : elle croît avec le
carré de la résolution.

Les 4 turbo ont aussi un **choix de sampler** : `euler` (celui du LoRA turbo, par défaut) ou
`res_multistep` (celui de l'app d'origine).

## H3 SLA Attention (ROCm) dans les 4 workflows H3

Le nœud `H3SLAAttentionROCM` (pack `comfyui-h3-sla-attention-rocm`) est inséré dans
`h3-video`, `h3-photo`, `extend-video` et `reshoot` — juste après le dernier LoRA de la
chaîne de modèle, ou juste après le modèle quand il n'y a pas de LoRA :

```
UNETLoader → [LoRA...] → H3 SLA Attention ROCM → BasicGuider + BasicScheduler
```

Réglages (ceux validés sur gfx1151/ROCm 10.1, ~30 % plus rapide) :
`sparsity_ratio 0.90`, `block_size 64`, `min_seq_len 8192`, `dense_last_steps 1`,
`protect_audio protect`, `enabled sparse`, `dense_steps ""`, `dense_backend comfy_kitchen`,
`disable_fp16_accum disabled (recommended)`, `stabilize_motion off`, `h3_cache off`,
`Protect Vid/Ref Off`.

Les clones turbo sont régénérés depuis ces workflows, donc ils l'ont aussi (après leur LoRA).
Appliqué/retiré par `local/apply-h3-sla.py` (appelé par `start.sh` et `update.sh`).

## Ports

`run-backend.sh` démarre à **8189** et prend le premier port libre au-delà : **8188 est
laissé à ton ComfyUI de `15_RUN_COMFYUI_ROCM101.sh`** (ce script ignore sa variable `PORT`,
son `exec` ne passe pas `--port`, donc il prend 8188). Le proxy suit (8190…), le gateway
reste sur 8000. Les ports retenus sont écrits dans `/tmp/opencode/riverfield/ports.env`.

`./start.sh` attend que le gateway et l'interface répondent et **échoue bruyamment** (code 1,
15 dernières lignes du log) si l'un des deux ne vient pas, au lieu d'afficher « prêt ».

## Menus et vignettes (overlay)

Deux apps ajoutées depuis les workflows ComfyUI maison (`audio_yue2_text2music.json` et
`audio_yue2_music_cover.json`), converties en API par `tools/ui2api.py` :

| App | Entrées | Modèle |
|---|---|---|
| `music-yue2` | style, paroles, durée, steps, « planifier la structure » | `yue2_3b_int8_convrot` |
| `music-yue2-cover` | chanson à reprendre, style, paroles, durée, steps | + `sheetsage2_bf16` (mélodie) |

Nouveau pack local `packs/audio-yue2.json` (5,35 Go, licence **CC BY-NC 4.0** : usage
personnel seulement). Les deux modèles sont déjà dans `ComfyUI/models`.

Mesuré ici : 20 s de chanson en 16 steps ≈ 22 s ; la reprise ≈ 26 s.

## Menus et vignettes (overlay)

RiverField décide de la place d'une app dans `web/js/catalog.js` et de sa vignette dans
`web/examples/index.json` — deux fichiers upstream. L'overlay les patche de façon
**idempotente** :

```sh
python3 local/apply-overlay.py            # applique (appelé par ./start.sh)
python3 local/apply-overlay.py --revert   # remet les fichiers upstream
```

Il ajoute les 4 turbo dans les groupes *Create* / *Camera* du studio vidéo, et les 2 YuE2
dans *Create* ; les vignettes viennent de `local/examples.json` (images/vidéos publiées
dans `web/examples/<app>/`).

Les vignettes de `h3-photo-turbo`, `extend-video-turbo` et `reshoot-turbo` réutilisent les
médias de leur app d'origine (le champ `run` de l'exemple le dit) en attendant un run turbo
maison ; `h3-video-turbo` et les deux YuE2 ont des médias réellement générés ici.

## Mettre à jour RiverField

```sh
./update.sh
```

Le script remet les deux fichiers de l'overlay à l'état upstream, fait `git pull --ff-only`,
`npm install` si besoin, reconstruit les apps turbo, réapplique l'overlay et valide.
C'est la seule commande à utiliser : un `git pull` direct échouerait sur les fichiers
modifiés par l'overlay.

Le générateur `local/make-turbo-apps.py` reconstruit les quatre apps depuis les workflows
upstream. **À relancer après chaque `git pull`** si RiverField change un graphe H3 :

```sh
cd ~/riverfield && python3 local/make-turbo-apps.py && npm run validate
```

Les LoRA ne sont pas déclarés dans `models` (pas d'entrée Hub) : ils doivent être dans
`ComfyUI/models/loras`, ce qui est le cas ici.

## Audio : Text to Speech (Chatterbox)

Deux apps ajoutées, sur **ComfyUI-Chatterbox** (wildminder, Apache-2.0) et les poids
**Chatterbox** de Resemble AI (MIT, 23 langues) :

| App | Entrées | Sortie |
|---|---|---|
| `tts` | texte, langue, expressivité, seed | voix (voix par défaut du modèle) |
| `tts-clone` | extrait de voix de référence + texte, langue, expressivité | la même voix lit le texte |

Les poids (~5 Go) se téléchargent tout seuls au premier run dans
`ComfyUI/models/tts/chatterbox/`. Mesuré ici : **4,1 s** pour une phrase en `tts`,
**4,6 s** en `tts-clone` (modèle chaud). Le nœud tourne sur ROCm ; la seule dépendance
ajoutée au venv est `s3tokenizer` (+ `onnx`, `ml_dtypes`, `protobuf`).


### OmniVoice (design et clonage, 600+ langues)

`ComfyUI-OmniVoice-TTS` (Saganaki22, MIT) + poids **OmniVoice** de k2-fsa (Apache-2.0, 0.6B) :

| App | Entrées | Sortie |
|---|---|---|
| `tts-omni` | texte + description de voix (vocabulaire fermé : femelle/mâle, âge, hauteur, accent, whisper) | la voix inventée lit le texte |
| `tts-omni-clone` | extrait de 3–15 s + texte (+ transcript optionnel) | la voix clonée lit le texte |

Le `voice_instruct` d'OmniVoice est une **liste d'attributs** (« female, low pitch, british accent »),
pas du texte libre : l'app l'expose en sélecteur multiple pour éviter les erreurs du modèle.
Poids : **3,2 Go** dans `ComfyUI/models/omnivoice/`, téléchargés au premier run, chargés en 3 s.
Mesuré ici : **4,1 s** (design) et **4,7 s** (clone) pour une phrase, modèle chaud.

Python 3.13 : l'installeur du nœud échoue sur `pyaudioop` (le module `audioop` a disparu de 3.13) ;
corrigé avec `pip install --no-deps audioop-lts`.


### Qwen3-TTS : incompatible, écarté

Testé et **abandonné** : Qwen3-TTS (`qwen-tts`) épingle `transformers==4.57.3`, alors
qu'OmniVoice exige `transformers>=5.3`. Dans le même venv, l'un casse l'autre.

Le nœud `ComfyUI-FL-Qwen3TTS` (vendored) se charge quand même sur transformers 5.19,
mais il faut recoller l'API RoPE (`default`) et `pad_token_id`, et le tokenizer audio
décode alors **1 s de silence**. Les 3 apps (`tts-qwen*`), le nœud et les 4,3 Go de poids
ont été retirés.

Pour l'avoir un jour : venv séparé + service HTTP à côté (nouveau type d'app), ou
sacrifier OmniVoice en redescendant transformers — aucun des deux n'est gratuit.

## Modèles

`./download-packs.sh <pack> <pack> ...` télécharge dans l'ordre, s'arrête à 35 Go libres.
Packs : `core image image-flux3 image-krea2 upscale image-qwen-edit image-moss
video-ltx25 video-h3 video-wan video-wan-effects video-wan-camera video-scail audio`.

Les fichiers déjà présents (même nom, ou mêmes octets sous un autre nom) sont réutilisés.

État au 28/10 : tous les packs sont complets **sauf**

| Pack | Manque | Pourquoi |
|---|---|---|
| `video-ltx25` | 8 LoRAs IC ≈ 8 Go | dépôts *gated* → `hf auth login` |
| `video-wan-camera` | 4 fichiers ≈ 33 Go | disque : il reste 48 Go libres, ce pack en prendrait 33 |

Pour finir le dernier pack (il restera ~15 Go libres) :

```sh
cd ~/riverfield && ./download-packs.sh video-wan-camera
```

Taille totale de `ComfyUI/models` après installation : 576 Go.

### Fichiers « gated » (401 sans token Hugging Face)

Les IC-LoRA LTX-2.5 vivent dans des dépôts à licence : cameraman, dubit, inpainting,
ingredients, sdr-to-hdr, water, clean-plate, day-to-night (≈7,7 Go).
Il faut accepter la licence sur huggingface.co puis :

```sh
/home/zardoz/comfyui-vanilla-gfx1151/.venv-r101/bin/hf auth login
cd ~/riverfield && ./download-packs.sh video-ltx25
```

Sans ça : `vfx-*`, `reframe`, `genjutsu`, `mixed-media`, `sdr-hdr`, `dub`,
`camera-copy` restent indisponibles ; `video`, `speak`, `talking`, `morph`,
`transitions` fonctionnent.
