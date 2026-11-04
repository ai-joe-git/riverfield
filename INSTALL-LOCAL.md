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
   - `LTX-2.5-Director` @ 17aa8bc3 (CGlide, build 2.5 du LTX Director de WhatDreamsCost),
     patché par `local/patch-ltx-director-iclora.py` — app `ltx-director`
   - `riverfield-ltx-planner` (copie de `local/custom_nodes/`) — construit `timeline_data`,
     `local_prompts` et `segment_lengths` pour le Director LTX
   - `riverfield-h3-planner` (copie de `local/custom_nodes/`) — document `timeline_data` H3
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

## Identité visuelle (BlackRiver)

La palette vient de blackriver-ai.com : fond **#020306**, panneaux **#0B0F16 / #101722**,
encre **#F0F4FA**, gris **#98A2B3 / #5F6877**, bordures `rgba(255,255,255,.10)`.
Accent principal : **bleu nuit #8DB4FF** (boutons, sélection, focus), avec **cyan #8DF1FF** et
**violet #B8A2FF** en supports ; le **menthe #58E6B1** est réservé aux états (prêt / ok), jamais
à l'action, comme sur le site où il n'est qu'une touche. Les grands titres prennent le dégradé
blanc → #BFC9D8 → bleu → cyan, le fond porte trois halos radiaux très bas (bleu, violet, cyan) et
le logo est un dégradé bleu → cyan. L'ambre #FFD166 ne sert qu'aux avertissements. Tout est dans `web/app.css` (`:root`) ; un changement de marque ne
demande qu'un bloc.

## MCP : piloter RiverField par agent

`mcp/server.ts` expose le studio en MCP (9 outils : `list_apps`, `get_app`, `run_app`, `job`,
`wait_job`, `cancel_job`, `history`, `gpu`, `examples`). C'est un client de l'API web : aucun
accès direct à ComfyUI.

- **HTTP** : `./start.sh` lance le serveur avec l'app → `http://127.0.0.1:3010/mcp`
  (`GET /health` pour vérifier). Logs dans `/tmp/opencode/riverfield/mcp.log`.
- **stdio** : `./run-mcp.sh --stdio`, pour les clients qui spawnent leur serveur.
- Branché dans `~/.config/opencode/opencode.jsonc` (`mcp.riverfield`, stdio) : mes propres outils
  `riverfield.*` l'ont validé (`run_app` → `wait_job` → `out/history/<id>/out-01.png`).
- `get_app` marque chaque entrée `file: true` (chemin absolu dans `run_app.files`) et
  `panel: true` (pilotée par un panneau web, mais acceptée par l'API), et renvoie les `notes`
  de l'app — c'est là que le format JSON du Material Planner de `studio-director` est décrit ;
- tous les nouveaux apps (`studio-director`, `h3-r2v-flex`) sont exposés automatiquement ;
- Détails, exemples curl et exemple « Studio Director » : `mcp/README.md`.

Ports par défaut : app 3000, MCP 3010, gateway 8000, ComfyUI 8189, proxy 8190.

## 3D : Image to 3D (TRELLIS.2 / Pixal3D)

Le studio a un onglet **3D** (`#/3d`) et une app `image-to-3d` bâtie sur
`3d_pixal3d_trellis2_image_to_model.json`, élaguée à ce qui sert le GLB (les aperçus
navigateur, l'atlas UV et la variante vertex-paint sont retirés).

| Entrée | |
|---|---|
| Photo | obligatoire, un objet seul et bien éclairé |
| Engine | **TRELLIS.2** (défaut) ou **Pixal3D** — le booléen du workflow bascule conditionnement, UNET et VAE ensemble |
| Texture | 1024 → 4096 px pour les cartes cuites (couleur, rugosité, AO, normale) |
| Seed | un seul pour les quatre samplers |

Sortie : un **`.glb`** (38,6 Mo à 1024, 576 s sur gfx1151) avec ses textures cuites. Mesuré ici :
`image-to-3d` en **9 min 42** à 1024 px.

### Ce qu'il a fallu changer pour le 3D

1. `schema/app.schema.json` : section `3d`, type de sortie `model`.
2. `server/history.ts` : `.glb/.gltf/.obj/.fbx/.stl/.ply/.usdz` → type `model` (sinon rangés en image).
3. `server/server.ts` : MIME `model/gltf-binary` etc. pour servir le fichier.
4. **`comfy-api-proxy` jetait les sorties 3D** : il ne connaît que `images, gifs, audio, text,
   files, latents`, et `Save3DAdvanced` publie sous la clé `3d`. `local/patch-proxy.py` ajoute
   `"3d": "file"` (idempotent, appelé par `run-backend.sh`, donc rejoué après toute réinstallation).
5. UI : `web/js/model3d.js` (three.js vendorisé dans `web/vendor/three`, import map dans
   `index.html`) affiche le GLB — orbite, zoom, auto-rotation — et `media.js` route le type `model`.

## Vidéo : Lipsync (LTX-2.5 IA2V)

`apps/lipsync` depuis `video_ltx2_5_IA2V_lipsync.json` : **audio obligatoire**, **photo
optionnelle**, prompt + **rewrite on/off**, négatif, format (8 ratios) et **résolution en
mégapixels** (0,4 → 1,5, défaut 0,8), durée, fps, seed. `VHS_LoadAudioUpload` est remplacé par
`LoadAudio` pour utiliser tout l'audio au lieu d'une fenêtre de 10 s.

### H3 Reference to Video (`h3-r2v`)

L'app la plus complète du studio, depuis `video_minimax_h3_r2v.json` : tout le pipeline de
références MiniMax H3 dans un seul graphe.

| Entrées | |
|---|---|
| `image1..9` | jusqu'à 9 photos, appelées `<Picture 1>` … dans le prompt |
| `video1..3` | jusqu'à 3 clips ; leurs frames deviennent `<Video N>` **et leur propre bande son** alimente le slot audio apparié (`GetVideoComponents`) |
| `audio1..3` | jusqu'à 3 audios seuls (`<Audio N>`) |
| prompt | références par nom, paroles entre guillemets |
| format + MP | 8 ratios, 0,4 → 1,5 MP |
| secondes | 1 → 15 (frames calculées par la formule du workflow : 24 fps, multiple de 17) |
| sampler | euler (défaut) ou res_multistep |
| turbo | le LoRA ref2v 4-step du workflow, ou le modèle complet |
| steps | 4 avec turbo, 20 sans (écrit dans les deux branches du switch) |
| seed | -1 aléatoire |

**Tous les slots sont optionnels.** Trois mécanismes ont été ajoutés pour ça :

1. `required: false` sur une entrée fichier → le runner ne la réclame plus (les fichiers restent
   requis par défaut, donc rien ne change pour les autres apps) ;
2. `unlink: [{node, field}]` sur l'entrée → quand elle est vide, l'arête vers le nœud 136 est coupée ;
3. `pruneGraph()` dans le runner → après application, tout nœud que les sorties ne peuvent plus
   atteindre est retiré du prompt (sinon le `LoadImage` orphelin restait validé par ComfyUI avec
   son nom de fichier factice et faisait échouer tout le prompt).

Mesuré ici : **264 s** pour 2 s en 4 steps sans aucune référence (0,4 MP), et le run à références
ci-dessus.

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

### MiniMax Music 3 Turbo et Turbo HQ

Deux apps sur le même graphe que `music`, avec le LoRA turbo communautaire
`minimax_music3_turbo_lora_8step.safetensors` (à garder dans `ComfyUI/models/loras`,
il n'est pas dans le pack `audio`) :

| App | Steps | Mesuré (20 s de chanson) |
|---|---|---|
| `music-turbo` | 8 (euler / simple) | **110,7 s** |
| `music-turbo-hq` | 12 | **180,7 s** |
| `music` (sans LoRA) | 20 | ~131 s (15 s d'audio) |

Entrées : style (caption), paroles, durée max, steps, seed. Sortie MP3 dans
`riverfield/music-turbo` et `riverfield/music-turbo-hq`. Le décodeur audio tuilé du
workflow d'origine (`VAEDecodeAudioTiled`) est conservé, avec repli sur `VAEDecodeAudio`.

### MOSS-Image et MOSS Turbo

`moss-image` **n'est plus un brouillon** : les trois poids sont sur le disque et l'app a tourné ici
(**190,9 s** pour 1 MP, 25 steps, cfg 2.5, rewrite activé), donc `status: ready`.

`moss-turbo` (workflow `image_moss_image_t2i_turbo.json`) ajoute le LoRA
`MOSS_8_STEPS_lora_latest.safetensors` (fichier local, pas dans le pack `image-moss`) :

| Réglage | Valeur |
|---|---|
| steps | **8 → 15** (défaut 8) |
| guidance (cfg) | **1.0 → 1.8** (défaut 1.5 ; l'app sans LoRA tourne à 2.5) |
| rewrite | toggle : passe le prompt dans qwen 9B « prompt engineer » comme le workflow d'origine |
| format | 8 ratios via `ResolutionSelector` |

Mesuré : **96,4 s** pour 1 MP à 8 steps, rewrite activé.

### Attention et mémoire (le crash de 8 s)

Les runs `h3-r2v` à **0,8 MP / 8 s** ont tué le backend (« lost »). La cause n'est pas la
mémoire du GPU mais **le mode d'attention** : on lançait ComfyUI avec
`--use-split-cross-attention` en global, à cause du plantage SDPA de ROCm 10.1 sur l'encodeur
**gemma4** de LTX-2.5. Or l'attention découpée de ComfyUI construit la matrice de scores
complète, en O(tokens²) **par tête** : à 8 s de vidéo H3 (~100 k tokens), cela demande des
centaines de Go — d'où la machine qui tombe, alors que le DiT tournait très bien en flash.

Corrigé en ciblant le problème :

- `custom_nodes/riverfield-gemma4-attn` force `attention_split` **uniquement** sur l'encodeur
  gemma4 (patch de `comfy.text_encoders.gemma4.optimized_attention_for_device`, rien de
  ComfyUI n'est modifié) ;
- `run-backend.sh` ne passe plus `--use-split-cross-attention` : tout le reste (H3, LTX, FLUX,
  Wan) garde l'attention PyTorch (AOTriton flash), mémoire linéaire ;
- ajout de `PYTORCH_HIP_ALLOC_CONF=expandable_segments:True` (moins de fragmentation) ;
- `--cache-none` est toujours là, et `--dont-upcast-attention` aussi.

Vérifié sans lancer d'inférence : ComfyUI démarre en « pytorch attention », le patch gemma4
renvoie bien `attention_split`, et la ligne de commande est
`--dont-upcast-attention --cache-none`.

### DynamicVRAM / comfy-aimdo désactivé (la vraie cause du crash des runs longs)

ComfyUI 0.34+ active par défaut **DynamicVRAM** (comfy-aimdo) : les poids sont « staged » puis
streamés vers le GPU. Sur GPU AMD en ROCm c'est un **bug connu, toujours ouvert** : runs qui
meurent sans traceback, machine figée, OOM alors que la mémoire est libre
([Comfy-Org/ComfyUI#16878](https://github.com/Comfy-Org/ComfyUI/issues/16878),
[#15255](https://github.com/Comfy-Org/ComfyUI/issues/15255)). Le rapport #15255 décrit
exactement notre cas : `h3_ref2va_pruned_int8_convrot` + TE `qwen3vl_32b_minimax_h3_nvfp4_awq`
+ VAE H3, tous les trois « Staged » (19995 + 14956 + 4965 MB).

Sur un iGPU c'est aggravé : comfy-aimdo annonce « VRAM: 114688 MB » alors que cette mémoire
**est** la RAM système (122 Go au total). Il croit donc disposer de 112 Go de VRAM *plus*
122 Go de RAM, et commit tout ce qu'il peut. La mémoire pinned (non swappable) empêche le
noyau de récupérer, et le run meurt d'un OOM noyau — sans traceback Python.

D'où les deux flags de `run-backend.sh` :

- `--disable-dynamic-vram` : retour au chargement classique (estimation, `loaded
  partially/completely`). C'est le workaround officiel du bug ;
- `--disable-pinned-memory` : inutile sur iGPU (aucun transfert PCIe) et non swappable.

`--cache-none` et `--dont-upcast-attention` restent. Un échantillonneur mémoire écrit
`ram_dispo`, `comfy_rss` et `gtt` toutes les 5 s dans `/tmp/opencode/riverfield/mem.log`
pour documenter le prochain essai.

### Le crash des runs 8 s : le GPU tombe (ring timeout), pas la mémoire

Le journal noyau est sans ambiguïté — à chaque essai H3 :

```
amdgpu 0000:c3:00.0: ring gfx_0.0.0 timeout, signaled seq=..., emitted seq=...
amdgpu 0000:c3:00.0: Starting gfx_0.0.0 ring reset
amdgpu 0000:c3:00.0: [drm] device wedged, but recovered through reset
```

Quatre crashes (23:28:44, 23:38:59, 23:49:42, 23:57:34), quatre fois la même signature. Le
shader ne rend jamais la main ; au bout de 10 s le noyau réinitialise le ring gfx, ce qui tue
la session graphique (gnome-shell, Xwayland, navigateur) — d'où l'impression que « la machine
plante ».

Ce n'est **pas** un manque de mémoire : au dernier relevé de `mem.log` avant le crash,
`ram_dispo=67 938 MB`, `comfy_rss=24 980 MB`, `gtt=29 560 MB`.

Les seuls noyaux GPU non standard de la boucle de sampling H3 sont :

- le nœud **H3 SLA** (kernel Triton, validé par son auteur sur RDNA2 et gfx1151 mais via un
  banc d'essai, pas une pipeline complète) ;
- le backend dense utilisé par ce nœud quand il délègue (séquences courtes, masques,
  protection audio) : `comfy_kitchen` (kernel HIP de comfy-kitchen) ou `auto` (= l'attention
  PyTorch, donc AOTriton — la même famille de code qui plantait sur l'encodeur gemma4 de
  LTX-2.5 avec `hipErrorProfilerNotInitialized`).

Indice décisif : `h3-video-turbo` à 5 s **réussit** avec `dense_backend=comfy_kitchen`, alors
que `h3-r2v` plantait avec `dense_backend=auto`. Les deux nœuds SLA de `h3-r2v` sont donc
passés à `comfy_kitchen`, comme toutes les autres apps H3.

En plus, l'app `h3-r2v` expose un interrupteur **« Sparse attention (SLA) »** : OFF, le nœud
rend le modèle inchangé et il ne reste plus aucun kernel Triton maison dans la boucle. C'est
le test de repli si un run devait encore figer le GPU (plus lent, mais minimal en risque).

À surveiller dans `/tmp/opencode/riverfield/mem.log` (RAM dispo, RSS du backend, GTT toutes
les 5 s) et dans `journalctl -k | grep "ring gfx"` : si un run fige encore, ces deux sources
disent tout de suite si c'est mémoire ou GPU.

### SVM : le déclencheur du ring timeout (ROCm/TheRock#2684)

Le message `svm_range_restore_work [amdgpu] hogged CPU for >10000us ... fois` qui précède
chaque timeout est la signature d'un livelock **SVM** propre à gfx1151 : sur une APU à mémoire
unifiée, le gestionnaire SVM du noyau se bat avec le reclaim, le GPU n'obtient jamais ses
pages, et le ring gfx part en timeout — le reset tue ensuite la session graphique.

C'est documenté par ROCm, sur le même matériel et avec la même enchaînement de logs :
[ROCm/TheRock#2684](https://github.com/ROCm/TheRock/discussions/2684) — « Strix Halo (gfx1151)
- 3x speedup on Hunyuan Video with 7.10 + HSA_USE_SVM=0 fix » :

```
svm_range_restore_work hogged CPU... 4099 times
ring gfx_0.0.0 timeout
VRAM is lost due to GPU reset!
```

Correctif donné par AMD/ROCm, et appliqué dans `run-backend.sh` :

```bash
export HSA_USE_SVM=0        # désactive la gestion SVM (la source du livelock)
export HSA_ENABLE_SDMA=0    # évite les hangs de copies SDMA
```

Le script faisait l'inverse : il **unset** `HSA_USE_SVM` (reprise de l'hygiène de
`15_RUN_COMFYUI_ROCM101.sh`), donc le SVM restait actif. Vérification :

```bash
pid=$(pgrep -f "main.py --listen 127.0.0.1 --port 8189" | head -1)
tr '\0' '\n' < /proc/$pid/environ | grep HSA
# HSA_ENABLE_SDMA=0
# HSA_USE_SVM=0
```

Le même correctif vaut pour ton ComfyUI perso (`15_RUN_COMFYUI_ROCM101.sh`) si tu y lances
aussi des vidéos longues.

Diagnostic après un essai : `journalctl -k | grep -E "svm_range|ring gfx"`. Si les lignes
`svm_range_restore_work` ont disparu et que plus rien ne tombe, c'était bien ça ; si le ring
timeout revient sans SVM, le suspect suivant est le kernel Triton du nœud SLA (interrupteur
« Sparse attention (SLA) » dans l'app `h3-r2v`).

### Attention creuse : Sol-Attn (HIP) à la place du kernel Triton du nœud SLA

Le nœud H3 SLA fournit un kernel **Triton** maison. Sur gfx1151 il ne rend jamais la main
dès que la séquence packée dépasse ~50k tokens (`topk >~ 90`) : le GPU se bloque, `ring
gfx_0.0.0 timeout`, reset, session tuée. C'est ce qui arrivait à chaque essai 8 s / 0.6-0.8 MP,
et le test « SLA off » a confirmé la cause en allant au bout — en 52 minutes, parce que
l'attention dense au même format coûte ~2.6e16 FLOP par step.

comfy-kitchen expose la **même sélection creuse** (`topk_ratio` = « SLA-style top-k ») en
kernel **HIP natif** :

```python
comfy_kitchen.sol_attn(q, k, v, topk_ratio=0.1, tail=False, sink_blocks=[0, n_prefix_blocks])
```

Mesures sur cette machine (T=32 768, H=56, D=128) :

| variante | temps |
| --- | --- |
| SDPA dense (bf16) | 7 082 ms |
| **sol_attn topk_ratio=0.1, tail=False** (fp16) | **346 ms** |

Soit **~20x** sur l'attention. `local/patch-h3-sla-solattn.py` remplace le point d'appel du
kernel Triton par `sol_attn` dans `sla/patch.py` (idempotent, sauvegarde
`sla/patch.py.orig-riverfield`). Le nœud garde tout le reste : garde `min_seq_len`, protection
audio en `sink_blocks`, repli dense automatique si le kernel refuse (donc en cas de problème
on retombe sur le chemin lent, jamais sur un crash).

À refaire après une réinstallation du nœud : `python local/patch-h3-sla-solattn.py`.
Si la qualité baisse, baisser `sparsity_ratio` (0.85) ou passer `tail=True` dans le patch.

Reste à optimiser ensuite : le **VAE decode** (~15 min des 52 min), indépendant de l'attention.

### Qualité de l'attention creuse : tail=True, token_aug, slider de détail

Premier retour d'usage : à `topk_ratio=0.1` avec `tail=False`, les visages sont flous et le
mouvement part en vrille. C'est le comportement attendu de `tail=False` : le softmax est
normalisé sur les **seuls blocs routés** (10 % de la séquence), donc le modèle perd tout le
contexte global.

Mesures sur tenseurs synthétiques (T=32 768, H=56, D=128, fp16), erreur moyenne vs SDPA dense :

| réglage | temps | erreur |
| --- | --- | --- |
| `topk_ratio=0.1, tail=False` | 378 ms | 0.0212 |
| `topk_ratio=0.1, tail=True` | 397 ms | **0.0056** |
| `topk_ratio=0.1, tail=True, token_aug=128` | 426 ms | 0.0056 |
| `topk_ratio=0.2, tail=True, token_aug=128` | 616 ms | 0.0054 |
| `topk_ratio=0.3, tail=True, token_aug=256` | 858 ms | 0.0050 |

`tail=True` divise l'erreur par **3,8 pour +5 % de temps** : c'est le réglage décisif. Le
patch l'active, plus `token_aug=128` (128 tokens exacts par bloc de requêtes, pour le détail
fin des visages).

Le reste du réglage est exposé dans l'app `h3-r2v` : curseur **« Sparse attention: detail »**
(0,9 = 90 % de blocs ignorés, le plus rapide ; 0,8 / 0,7 = plus de blocs exacts, plus de
détail, plus lent). Il est lié à `sparsity_ratio` des deux nœuds.

Ordre de réglage si la qualité manque encore : 0,85 puis 0,80 (≈ +30 % de temps par palier),
et seulement ensuite envisager `token_aug=256`.

### App « H3 Pika Flex » (template officiel, autre LoRA)

`video_pika_h3_flex_ref2va.json` (le template ComfyUI livré avec le modèle) n'utilise **pas**
la même recette que `h3-r2v` :

| | h3-r2v (turbo) | h3-r2v-flex (Pika) |
| --- | --- | --- |
| LoRA | `minimax_h3_ref2v_turbo_4step_v0.1` | `pika_h3_flex_ref2va_v1_bf16` |
| sampler | euler + BasicScheduler simple | **lcm** |
| steps | 4 (LoRA turbo) | **6** via `ManualSigmas` 1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0 |

C'est une piste sérieuse pour la qualité : une bonne part du rendu « dégueu » peut venir du
LoRA 4-step, pas de l'attention creuse.

App créée avec `tools/import_workflow.py` sous `apps/h3-r2v-flex` (section video), entrées :
image de référence, prompt, résolution (0,4–1,5 MP, défaut 0,8), durée (1–15 s, défaut 8),
curseur de détail de l'attention creuse, seed. Le nœud SLA est branché sur Sol-Attn (patch
`local/patch-h3-sla-solattn.py`) avec repli dense sur `comfy_kitchen`.

Note : le template ne câble qu'un seul emplacement d'image de référence ; `h3-r2v` garde ses
9 images / 3 vidéos / 3 audios.

### RiverField Studio Director (Material Planner)

App `studio-director` : le workflow `RiverField_Director_studio.json` avec **60 entrées**, soit
100 % des réglages de chacun des 12 nœuds — modèles, dtype, encodeur, VAE vidéo/audio, LoRA et
force, sampler, scheduler, steps, denoise, seed, résolution (format / MP / multiple), les 12
options du nœud SLA, les 3 options du sampler de segments, et les 3 options d'encodage vidéo.

**Le Material Planner est reconstruit côté app.** Le plugin garde tout son état dans le widget
`timeline_data` (JSON v10 : bin média, prompt global, fenêtres et prompts par segment, two-stage).
Un widget ne peut pas être rempli par un formulaire, donc
`custom_nodes/riverfield-h3-planner` (copie dans `local/custom_nodes/`) construit ce document à
partir des champs de l'app (`json.dumps`, donc guillemets et retours à la ligne sûrs) et le
branche sur `MiniMaxH3TimelinePlanner.timeline_data`.

Champs couverts, à l'identique du planner : 9 images, 3 vidéos, 3 audios, mode audio
(`reference` / `locked`), son des vidéos, prompt global, durée de segment, nombre de segments,
prompts par segment, début sur la timeline, two-stage + upscaler + steps haute résolution.
Les fenêtres suivent la géométrie du plugin (`js/segment_windows.mjs`) : longueurs H3
`5 + 17n`, chevauchement de 39 frames (le plus proche autorisé).

Ce qui n'est **pas** dans le formulaire : l'édition au canevas (glisser/rogner les clips) et
l'affectation média par segment. Pour ça, `Advanced: raw timeline JSON` reçoit le document
complet et il est passé tel quel au planner.

Vérifications faites sans inférence :
- le nœud + le planner exécutés seuls dans ComfyUI (`PreviewAny` en sortie) : plan
  `MINIMAX_H3_TIMELINE_PLAN` correct, prompt avec guillemets et saut de ligne intact ;
- le workflow complet construit par `applyInputs` du runner : tous les binds atterrissent
  (durée sur le builder **et** le planner, fichiers sur les champs du builder, SLA, SaveVideo) ;
- validation statique du graphe : classes, entrées (y compris les combos dynamiques de
  `SaveVideo`), liens et types.

À refaire après réinstallation de ComfyUI : copier
`local/custom_nodes/riverfield-h3-planner` dans `ComfyUI/custom_nodes/`.

### LTX Director 2.5 (app `ltx-director`)

Le Director LTX n'est pas un nœud maison : c'est le pack
`CGlide/LTX-2.5-Director` (build 2.5 du LTX Director de WhatDreamsCost), cloné dans
`ComfyUI/custom_nodes/LTX-2.5-Director`. Ses nœuds sont `LTXDirectorCS25`,
`LTXDirectorGuideCS25` et `LTXDirectorCropGuidesCS25` ; ils portent des noms `CS25` et
cohabitent donc avec le pack 2.3, contrairement à ce que dit le README du pack.

Le workflow des deux apps vient de `example_workflows/LTX_2_5_Director_CS.json`, converti
avec `tools/ui2api.py` puis adapté :

- **sans** les patches SageAttention / Triton de l'exemple (`PathchSageAttentionKJ`,
  `LTX2MemoryEfficientSageAttentionPatch`, `LTX2AttentionTunerPatch`) : mêmes kernels que
  le SLA H3, ils coincent gfx1151. `LTXVChunkFeedForward` (pur PyTorch) est gardé ;
- UNet `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot` directement (le LoRA
  `distilled-lora-450` de l'exemple est inutile avec le vrai distilled, et absent en local) ;
- VAE `ltx-2.5-video-vae-bf16` (le `conv` n'est pas installé) + `ltx-2.5-audio-vae-bf16` ;
- stage 1 = sigmas officiels **8 steps** du 2.5, stage 2 = 3 steps après l'upscale latent x2 ;
- sortie `CreateVideo` + `SaveVideo` (Core), pas VHS/nvenc.

`custom_nodes/riverfield-ltx-planner` (copie de `local/custom_nodes/`) traduit les fenêtres
du panneau (frames 24 fps, longueurs H3 `5+17n`) en `timeline_data`, `local_prompts`,
`segment_lengths` et géométrie `duration_frames` (snap `8n+1`), puis les branche sur
`LTXDirectorCS25` et `ResolutionSelector`.

**Références** : le combo `ic_lora_name` de `LTXDirectorGuideCS25` refuse un lien STRING
(« Return type mismatch »), donc une app ne peut pas choisir le LoRA à l'exécution. Le patch
`local/patch-ltx-director-iclora.py` ajoute au guide une entrée socket optionnelle
`ic_lora_override` qui gagne sur le combo, sans toucher au menu déroulant côté ComfyUI. Le
planner y branche `"None"` ou le LoRA choisi : feuille vide = texte pur, feuille fournie =
Ingredients IC-LoRA.

Le planner transforme la feuille en clip fixe (`ffmpeg -loop 1`, résolution stage 1) déposé
dans `ComfyUI/input`, parce que la piste motion du Director ne lit que des fichiers vidéo, et
le guide applique le LoRA lui-même. Le patch est idempotent et laisse une sauvegarde
`ltx_director_guide.py.orig-riverfield`.

Mesures (gfx1151, `--cache-none`, sans reserve-vram) :
- 2 plans, 5,16 s, 1280x704, 8 steps = **495 s** ;
- feuille de références, 2,28 s, 896x512, 3 steps = **192 s** (via l'app, upload compris) ;
- texte sans feuille, 1 s, 896x512, 3 steps = **96 s** ; le log du guide dit
  `ic_lora_name: None`, le LoRA n'est pas chargé.

À refaire après réinstallation de ComfyUI : cloner `LTX-2.5-Director`, lancer
`python local/patch-ltx-director-iclora.py`, puis copier
`local/custom_nodes/riverfield-ltx-planner` dans `ComfyUI/custom_nodes/`.

### Studio Director : le panneau Material Planner (interface)

La page de l'app `studio-director` n'est plus un formulaire : elle ouvre un **panneau de
metteur en scène** (`web/js/director.js` + styles `.dir-*` dans `web/app.css`), à droite, avec
la colonne des réglages techniques à gauche.

Le panneau :
- **bin média** : Pictures (9), Videos (3), Audios (3), dépôt ou clic, vignettes, retrait,
  assignation à un segment d'un clic (images/audios), et **glisser-déposer sur la timeline**
  (une vidéo/audio se pose où on la lâche, une image lâchée sur la piste GEN rejoint le segment
  sous le curseur) ;
- **glisser-déposer maison** (pas le DnD HTML du navigateur) : la source s'estompe, un fantôme
  flottant suit le curseur (rAF), la piste compatible s'allume, un aperçu en pointillés — créé
  une seule fois, donc sans clignotement — montre où le clip se posera, et **Échap / perte de
  focus annulent proprement** ; les références de segment se réordonnent avec un marqueur
  d'insertion ;
- **aimantation** type table de montage : fenêtres et clips se collent aux bords voisins, au
  zéro et à la tête de lecture (seuil 9 px) avec une ligne guide verte ; les clips vidéo/audio
  ont aussi une croix pour les retirer de la timeline ;
- **timeline** frame-accurate : règle en secondes, zoom, fenêtres **GEN** déplaçables et
  redimensionnables à la frame, longueur aimantée en `5 + 17n` au relâchement (bouton **H3**
  pour aligner à la demande), champs **START / LENGTH** en secondes (pas de 1/24) pour la
  précision, clips vidéo/audio déplaçables **et rognables** (poignées gauche/droite), tête de
  lecture, couture de 39 frames, pas de trou ;
- **vidéos** : durée et dimensions lues à l'import (durée du clip bornée au fichier), rognage
  (`trimStart`), mode de référence **guide / edit / boundary** par clip, et liste « Videos here »
  dans l'éditeur de segment (les vidéos sont des clips de timeline, recoupés par fenêtre) ;
- **cartes matériau** (remplace les pastilles ovales) : coins 10 px, vignette carrée 26 px,
  badge `<Picture N>` / `<Audio N>` / `LOCK`, nom tronqué, actions (◀ ▶ ×) séparées par un
  filet — même langage pour les puces d'ajout (bordure pointillée), le fantôme de drag et les
  toggles ; les clips trop étroits n'affichent plus que leur durée ;
- **éditeur de segment** : prompt du segment, chronologie, ajout/suppression, et références
  **ordonnées** du segment — `<Picture 1..n>` / `<Audio 1..n>` (ou `LOCK` en mode Keep original),
  réordonnables par glisser-déposer ou par les flèches ◀ ▶, retirables, exactement l'ordre que le
  planner traduit en libellés dans le prompt ;
- **pied** : prompt global + bouton Generate ;
- en-tête : Two-stage (avec sélecteur d'upscaler et steps haute résolution quand il est actif),
  compteur segments/durée/frames, zoom ;
- sections Vidéos/Audios : interrupteur « sound » (son des vidéos) et mode audio
  « Reference / Keep original ».

Ce que le panneau écrit, et que le runner envoie :
- `f.files[imageN|videoN|audioN]` pour les médias (même mécanisme que les dropzones normaux) ;
- `f.values.segment_windows` : `{windows:[{start,end,prompt,images:[i],audios:[i]}], videos:[…],
  audios:[…]}` en frames, lu par le nœud `RiverFieldH3Planner` ;
- `duration` (durée du premier segment) et `segment_count`, pour le planner.

Les champs correspondants sont marqués `"hidden": true` dans `app.json` : le formulaire
générique ne les rend plus (propriété ajoutée au schéma), seul le panneau les pilote.

Vérifié : capture Chromium headless (panneau complet rendu, aucune erreur console), et test
synthétique de bout en bout (fenêtres 0–192 / 153–345, prompts avec guillemets, médias par
segment : segment 1 → image 1, segment 2 → images 1+2, plan `MINIMAX_H3_TIMELINE_PLAN`).

### Deux apps Director : libre et verrouillée Pika

- **`studio-director` — RiverField Studio Director** : liberté totale — modèle, dtype, VAE, choix
  du LoRA et de sa force, **interrupteur turbo** (applique le LoRA ou passe le modèle brut),
  **sampler**, **scheduler**, **steps**, **denoise**, et les 12 options SLA. C'est la version pour
  expérimenter avec n'importe quel modèle ; un mauvais preset peut dégrader le rendu, c'est le
  prix de la liberté.
- **`pika-studio-director` — Pika Studio Director** : même graphe, **recette Pika figée** —
  `lcm` + `ManualSigmas` 1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0,
  `pika_h3_flex_ref2va_v1_bf16` à 1.0, `minimax_h3_ref2va` int8, encodeur nvfp4, VAE lynnreal,
  SLA Sol-Attn. Seules les options créatives sont exposées (médias, prompts, segments, résolution,
  détail 0.8–0.95, two-stage, seed, sortie) : impossible de casser la recette.

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
