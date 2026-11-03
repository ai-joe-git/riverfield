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
- Détails et exemples curl : `mcp/README.md`.

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
