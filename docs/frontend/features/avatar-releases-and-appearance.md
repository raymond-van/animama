# Avatar Content And Appearance

Avatars and Appearance Images use Included/Local typed catalog items. Reviewed
loadout commands select logical items. A mounted runtime
pins exact revisions and adopts later source edits only after remount.

The Anima management Appearance dialog edits Profile and Background as
independent typed bindings. It can save a Local Appearance Image and frame it
with Fill/Fit, focal point, and zoom before a reviewed loadout commit. Upload
failure never changes the loadout; Cancel discards unsaved framing. Removing a
profile override permits the registered Avatar portrait fallback. Background
lists the app scenes (Dreamy, the light default; Bedroom; Sakura, the dark
default; Seaside; Rooftop; Café; Classroom), None, and Local images. With no
bound image, chat draws the chosen scene's light or dark image from `public/background/`; the Anima page
always shows the Dreamy pedestal backdrop in the current theme. The scene is stored per Anima as
`preferences.presentation.stage_background`; `none` leaves the plain theme
background, and a bound Local image keeps the stored scene for when it is
removed. Scenes are listed in `lib/stage-background/stageBackground.ts`.
Included
portraits and Local images use protected catalog delivery, not public storage
URLs.

The browser captures Avatar portraits with `captureAvatarPortrait` (also the
development-only `/avatar-portrait-debug` harness). When the Create Anima stage
shows a saved Local Avatar without a portrait, or with one captured from
another revision, it captures one in the background and saves it through the
typed portrait API (`ui/create-anima/createAnimaPortrait.ts`). It captures the
Avatar at rest, waiting while a Gesture or Reaction preview plays or the page
is hidden. The attempt never blocks the flow, is abandoned after 15 s or when
the source changes, the stage unmounts or the page is hidden, and a failure is
only logged and not retried until the app is reloaded. The Library's Preview
Dock follows the same rules (`useDockPortraitRetake`). When the Library previews
a Local Avatar whose portrait is missing or from another revision, as after
[Replace VRM](library.md), the Dock captures it once the model has loaded and
no Action is playing. Included Avatars, unsaved uploads and imported portraits
are never recaptured. A retaken Local portrait keeps its file URL, so the
Library card and Create Anima's Avatar list add that Avatar's save count from
`avatar-portrait-version-store` to the URL and show the new image without a
reload. Avatar portraits (Appearances naming an Avatar in
`presentation.avatar_item_id`, generated or imported) are not offered as
Profile or Background images. Creation itself submits null Profile and Background
bindings. Background Default means the normal app stage.

`/animas/new` accepts a logical Avatar handoff, with a saved draft taking
precedence. Confirmed uploads survive cancellation; unsaved files require
reselection after reload. See the
[live creation guide](custom-anima-creation.md) and its
[acceptance status](custom-anima-creation.md#acceptance-and-regression-coverage).
