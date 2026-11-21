// The app shell, laid out and styled like the web app (base.css + canvasStyles.css, neomorphic theme):
// library sidebar, top bar, and the canvas with its floating tool bar, pen palette, and selection bar.
package app.aurora.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.aurora.notes.canvas.CanvasView
import app.aurora.notes.canvas.Tool
import app.aurora.notes.data.Background
import app.aurora.notes.data.LibraryFolder
import app.aurora.notes.data.LibraryNote
import kotlin.math.roundToInt

private val shellGap = 12.dp

/** Number of open dialogs; the shell blurs behind them like the web's backdrop-filter: blur(7px). */
private val LocalModalCount = androidx.compose.runtime.compositionLocalOf { mutableStateOf(0) }

@Composable
fun AuroraApp(state: AppState) {
    var collapsed by remember { mutableStateOf(state.settings.sidebarCollapsed) }
    val sidebarWidth = remember { mutableStateOf(state.settings.sidebarWidth) }
    // 0 = collapsed, 1 = open. Read only in layout and draw, so the animation never recomposes the shell.
    val openness = androidx.compose.animation.core.animateFloatAsState(
        if (collapsed) 0f else 1f,
        androidx.compose.animation.core.tween(260, easing = androidx.compose.animation.core.FastOutSlowInEasing),
        label = "sidebar",
    )
    var settingsOpen by remember { mutableStateOf(false) }
    val modals = remember { mutableStateOf(0) }

    androidx.compose.runtime.CompositionLocalProvider(LocalModalCount provides modals) {
    androidx.compose.material3.ProvideTextStyle(TextStyle(fontFamily = AuroraFont)) {
    Box(Modifier.fillMaxSize().then(if (modals.value > 0) Modifier.blur(7.dp) else Modifier)) {
        AppBackground()
        Row(
            Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).padding(16.dp),
        ) {
            Sidebar(state, collapsed, sidebarWidth, openness, onToggle = { collapsed = !collapsed; state.settings.sidebarCollapsed = collapsed })
            SidebarResizer(
                enabled = !collapsed,
                onDrag = { dx -> sidebarWidth.value = (sidebarWidth.value + dx).coerceIn(220f, 520f) },
                onDone = { state.settings.sidebarWidth = sidebarWidth.value },
                onReset = { sidebarWidth.value = 280f; state.settings.sidebarWidth = 280f },
            )
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(shellGap)) {
                TopBar(state, onSettings = { settingsOpen = true })
                CanvasArea(state, Modifier.weight(1f).fillMaxWidth())
            }
        }
    }
    if (settingsOpen) SettingsDialog(state) { settingsOpen = false }
    }
    }
}

// ---- Shared pieces ---------------------------------------------------------

@Composable
fun LucideIcon(icon: ImageVector, size: Int, tint: Color = Neo.text, modifier: Modifier = Modifier) {
    Icon(icon, null, tint = tint, modifier = modifier.size(size.dp))
}

/** button.icon-button / .tree-action: 28dp, transparent, radius 11. */
@Composable
internal fun IconButton(icon: ImageVector, size: Int = 16, box: Dp = 28.dp, tint: Color = Neo.text, onClick: () -> Unit) {
    Box(Modifier.size(box).clip(RoundedCornerShape(11.dp)).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        LucideIcon(icon, size, tint)
    }
}

/** Plain `button`: surface fill, hairline border, radius 16, outset shadow, 6/12 padding. */
@Composable
internal fun NeoButton(
    modifier: Modifier = Modifier,
    fill: Color = Neo.surface,
    shadow: Boolean = true,
    radius: Dp = Neo.radius,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    Box(
        modifier.panel(if (shadow) Neo.outset else emptyList(), radius, fill).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
    ) { content() }
}

@Composable
internal fun Label(text: String, size: TextUnit = 14.sp, color: Color = Neo.text, weight: FontWeight = FontWeight.Normal, modifier: Modifier = Modifier, spacing: TextUnit = TextUnit.Unspecified) {
    Text(text, color = color, fontSize = size, fontWeight = weight, letterSpacing = spacing, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = modifier)
}

private fun Modifier.dashedBorder(color: Color, radius: Dp) = drawBehind {
    val r = radius.toPx()
    drawRoundRect(color, cornerRadius = androidx.compose.ui.geometry.CornerRadius(r, r),
        style = Stroke(width = 1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 5f))))
}

// ---- Sidebar ---------------------------------------------------------------

private sealed interface LibraryDialogKind {
    data object Project : LibraryDialogKind
    data class Folder(val projectId: String) : LibraryDialogKind
    data class Note(val projectId: String, val folderId: String?) : LibraryDialogKind
}

@Composable
private fun Sidebar(
    state: AppState, collapsed: Boolean, openWidth: androidx.compose.runtime.State<Float>,
    openness: androidx.compose.runtime.State<Float>, onToggle: () -> Unit,
) {
    val expanded = remember { mutableStateMapOf<String, Boolean>().apply { state.settings.expandedTreeItems.forEach { put(it, true) } } }
    val toggleOpen = { id: String ->
        expanded[id] = !(expanded[id] ?: false)
        state.settings.expandedTreeItems = expanded.filterValues { it }.keys
    }
    var dialog by remember { mutableStateOf<LibraryDialogKind?>(null) }
    var overlay by remember { mutableStateOf<String?>(null) }
    val tree = state.library
    val notes = tree.notes.filter { !it.trashed && !it.archived }

    // The panel's width animates in layout only; its contents stay composed at the open width,
    // clipped by the panel and faded, so opening never rebuilds or re-wraps the tree.
    Box(
        Modifier.fillMaxHeight()
            .layout { measurable, constraints ->
                val w = (48.dp + (openWidth.value.dp - 48.dp) * openness.value).roundToPx()
                val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
                layout(w, placeable.height) { placeable.place(0, 0) }
            }
            .panel(Neo.shell),
    ) {
    Column(
        Modifier.wrapContentWidth(Alignment.Start, unbounded = true)
            .layout { measurable, constraints ->
                val w = openWidth.value.dp.roundToPx()
                val placeable = measurable.measure(constraints.copy(minWidth = w, maxWidth = w))
                layout(w, placeable.height) { placeable.place(0, 0) }
            }
            .fillMaxHeight()
            // Contents fade in over the second half of opening and are gone early when closing.
            .graphicsLayer { alpha = ((openness.value - 0.45f) / 0.55f).coerceIn(0f, 1f) }
            .padding(shellGap),
        verticalArrangement = Arrangement.spacedBy(shellGap),
    ) {
        Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Label("Aurora", 15.sp, weight = FontWeight.Bold, modifier = Modifier.weight(1f).padding(start = 6.dp))
            IconButton(Lucide.Search, 16) { overlay = "search" }
            IconButton(Lucide.Trash2, 16) { overlay = "trash" }
            Spacer(Modifier.width(28.dp)) // the toggle sits here, drawn above
        }

        val favorites = notes.filter { it.favorite }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (favorites.isNotEmpty()) {
                item { SectionTitle("Favorites", Lucide.Heart) }
                favorites.forEach { note -> item("fav-${note.id}") { NoteItem(state, note) } }
            }
            item { SectionTitle("Projects") }
            for (project in tree.projects.sortedBy { it.order }) {
                val open = expanded[project.id] ?: false
                item(project.id) {
                    TreeItem(selected = false, onClick = { toggleOpen(project.id) }, actions = {
                        IconButton(Lucide.FolderPlus, 15) { dialog = LibraryDialogKind.Folder(project.id) }
                        IconButton(Lucide.Plus, 15) { dialog = LibraryDialogKind.Note(project.id, null) }
                    }) {
                        Chevron(open)
                        LucideIcon(if (open) Lucide.FolderOpen else Lucide.Folder, 16, Neo.muted)
                        Label(project.name, weight = FontWeight.Bold)
                    }
                }
                item("${project.id}-children") {
                    Reveal(open) {
                        TreeChildren {
                            for (folder in tree.folders.filter { it.projectId == project.id && it.parentId == null }) {
                                FolderTree(state, folder, tree.folders, notes, expanded, toggleOpen) { folderId -> dialog = LibraryDialogKind.Note(project.id, folderId) }
                            }
                            for (note in notes.filter { it.projectId == project.id && it.folderId == null }) NoteItem(state, note)
                        }
                    }
                }
            }
            item {
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, end = 4.dp, top = 8.dp).clip(RoundedCornerShape(Neo.radius))
                        .dashedBorder(Neo.border.copy(alpha = 0.16f), Neo.radius).clickable { dialog = LibraryDialogKind.Project }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                    horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                ) {
                    LucideIcon(Lucide.Plus, 16, Neo.muted)
                    Spacer(Modifier.width(7.dp))
                    Label(if (tree.projects.isEmpty()) "Create first project" else "New project", color = Neo.muted)
                }
            }
        }
    }

    // Hidden contents must not take taps while collapsed.
    if (collapsed) Box(Modifier.matchParentSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {})
    // The toggle rides the panel's right edge: centred in the 48dp rail when closed, at the header's end when open.
    Box(Modifier.align(Alignment.TopEnd).offset {
        val inset = (10.dp + 6.dp * openness.value).roundToPx()
        IntOffset(-inset, (shellGap + 4.dp).roundToPx())
    }) {
        IconButton(if (collapsed) Lucide.PanelLeftOpen else Lucide.PanelLeftClose, 18, onClick = onToggle)
    }
    }

    when (overlay) {
        "search" -> SearchDialog(state) { overlay = null }
        "trash" -> TrashDialog(state) { overlay = null }
    }
    dialog?.let { kind -> LibraryDialog(kind, onDismiss = { dialog = null }) { name, mode, background ->
        dialog = null
        when (kind) {
            LibraryDialogKind.Project -> state.launch { state.api.createProject(name) }
            is LibraryDialogKind.Folder -> state.launch { state.api.createFolder(kind.projectId, name) }
            is LibraryDialogKind.Note -> state.launch { state.api.createNote(kind.projectId, kind.folderId, name, mode, background) }
        }
    } }
}

/** The shell gap between sidebar and main column doubles as a drag strip that resizes the sidebar. */
@Composable
private fun SidebarResizer(enabled: Boolean, onDrag: (Float) -> Unit, onDone: () -> Unit, onReset: () -> Unit) {
    var dragging by remember { mutableStateOf(false) }
    var input = Modifier.width(shellGap).fillMaxHeight()
    if (enabled) input = input
        .pointerInput(Unit) {
            detectHorizontalDragGestures(
                onDragStart = { dragging = true },
                onDragEnd = { dragging = false; onDone() },
                onDragCancel = { dragging = false; onDone() },
            ) { change, dx -> change.consume(); onDrag(dx.toDp().value) }
        }
        .pointerInput(Unit) { detectTapGestures(onDoubleTap = { onReset() }) }
    Box(input, contentAlignment = Alignment.Center) {
        if (enabled) Box(
            Modifier.size(3.dp, if (dragging) 120.dp else 36.dp).clip(RoundedCornerShape(2.dp))
                .background(if (dragging) Neo.accent.copy(alpha = 0.55f) else Neo.border.copy(alpha = 0.16f)),
        )
    }
}

@Composable
private fun SectionTitle(text: String, icon: ImageVector? = null) {
    Row(Modifier.padding(start = 8.dp, end = 8.dp, top = 6.dp, bottom = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        icon?.let { LucideIcon(it, 12, Neo.muted); Spacer(Modifier.width(5.dp)) }
        Label(text.uppercase(), 11.sp, Neo.muted, spacing = 0.08.em)
    }
}

/** .tree-children: indented under a hairline. */
@Composable
private fun TreeChildren(content: @Composable () -> Unit) {
    Row(Modifier.padding(start = 14.dp).height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
        Box(Modifier.width(1.dp).fillMaxHeight().background(Neo.border))
        Column(Modifier.padding(start = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) { content() }
    }
}

/** .tree-item: a 36dp row; selected rows are pressed in with an accent edge. */
@Composable
internal fun TreeItem(selected: Boolean, onClick: () -> Unit, actions: (@Composable () -> Unit)? = null, content: @Composable RowScope.() -> Unit) {
    val shape = RoundedCornerShape(13.dp)
    var row = Modifier.fillMaxWidth().clip(shape)
    if (selected) row = row.background(Neo.bgRaised).insetShadow(Neo.inset, 13.dp).drawBehind {
        drawRect(Neo.accent, size = androidx.compose.ui.geometry.Size(2.dp.toPx(), size.height))
    }
    Row(row.clickable(onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).heightIn(min = 36.dp).padding(horizontal = 9.dp, vertical = 7.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) { content() }
        if (actions != null) Row(Modifier.padding(end = 4.dp).alpha(0.9f), horizontalArrangement = Arrangement.spacedBy(1.dp)) { actions() }
    }
}

@Composable
private fun FolderTree(
    state: AppState, folder: LibraryFolder, folders: List<LibraryFolder>, notes: List<LibraryNote>,
    expanded: Map<String, Boolean>, onToggleOpen: (id: String) -> Unit, onAddNote: (folderId: String) -> Unit,
) {
    val open = expanded[folder.id] ?: false
    TreeItem(selected = false, onClick = { onToggleOpen(folder.id) }, actions = { IconButton(Lucide.Plus, 15) { onAddNote(folder.id) } }) {
        Chevron(open)
        LucideIcon(if (open) Lucide.FolderOpen else Lucide.Folder, 16, Neo.muted)
        Label(folder.name)
    }
    Reveal(open) {
        TreeChildren {
            for (child in folders.filter { it.parentId == folder.id }) FolderTree(state, child, folders, notes, expanded, onToggleOpen, onAddNote)
            for (note in notes.filter { it.folderId == folder.id }) NoteItem(state, note)
        }
    }
}

/** Tree children slide open and fade in, and fold away the same way. */
@Composable
private fun Reveal(visible: Boolean, content: @Composable () -> Unit) {
    androidx.compose.animation.AnimatedVisibility(
        visible,
        enter = androidx.compose.animation.expandVertically(androidx.compose.animation.core.tween(180)) +
            androidx.compose.animation.fadeIn(androidx.compose.animation.core.tween(180)),
        exit = androidx.compose.animation.shrinkVertically(androidx.compose.animation.core.tween(160)) +
            androidx.compose.animation.fadeOut(androidx.compose.animation.core.tween(120)),
    ) { content() }
}

/** A right chevron that turns down as its row opens. */
@Composable
private fun Chevron(open: Boolean) {
    val angle by androidx.compose.animation.core.animateFloatAsState(if (open) 90f else 0f, androidx.compose.animation.core.tween(180), label = "chevron")
    LucideIcon(Lucide.ChevronRight, 15, modifier = Modifier.graphicsLayer { rotationZ = angle })
}

@Composable
private fun NoteItem(state: AppState, note: LibraryNote) {
    TreeItem(selected = note.id == state.openNoteId, onClick = { state.open(note.id) }) {
        LucideIcon(Lucide.FileText, 16, Neo.muted)
        Label(note.title.ifBlank { "Untitled" }, modifier = Modifier.weight(1f))
        if (note.favorite) LucideIcon(Lucide.Star, 13, Neo.accent)
    }
}

// ---- Library dialog (mirrors the web's .library-dialog) ---------------------

private val canvasModes = listOf("infinite" to "Infinite", "fixed-width" to "Fixed width", "fixed-height" to "Fixed height", "paged" to "Pages")
private val patterns = listOf("dot-grid" to "Dots", "square-grid" to "Grid", "ruled" to "Ruled", "blank" to "Blank")
private val noteColors = listOf("#171a21", "#111827", "#18152a", "#17211d", "#21191b")

@Composable
private fun LibraryDialog(kind: LibraryDialogKind, onDismiss: () -> Unit, onCreate: (String, String, Background) -> Unit) {
    var name by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("infinite") }
    var pattern by remember { mutableStateOf("dot-grid") }
    var color by remember { mutableStateOf(noteColors[0]) }
    val title = when (kind) { LibraryDialogKind.Project -> "New project"; is LibraryDialogKind.Folder -> "New folder"; is LibraryDialogKind.Note -> "New note" }
    val isNote = kind is LibraryDialogKind.Note

    NeoDialog(onDismiss) {
        DialogHeader("Library", title, onDismiss)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Label("Name", 12.sp, Neo.muted)
            NeoTextField(name, { name = it }, Modifier.heightIn(min = 42.dp))
        }
        if (isNote) {
            ChoiceField("Canvas style") { Segmented(canvasModes, mode) { mode = it } }
            ChoiceField("Background style") { Segmented(patterns, pattern) { pattern = it } }
            ChoiceField("Canvas color") {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    for (c in noteColors) {
                        val selected = c == color
                        Box(Modifier.size(38.dp + if (selected) 10.dp else 0.dp)
                            .then(if (selected) Modifier.border(2.dp, Neo.accent, CircleShape).padding(5.dp) else Modifier)
                            .clip(CircleShape).background(hex(c)).border(1.dp, Neo.border, CircleShape).clickable { color = c })
                    }
                }
            }
            PatternPreview(Background(pattern, color, "#354052", 24.0))
        }
        Row(Modifier.fillMaxWidth().padding(top = 2.dp), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            NeoButton(fill = Color.Transparent, shadow = false, onClick = onDismiss) { Label("Cancel") }
            NeoButton(fill = Neo.accent, onClick = {
                val trimmed = name.trim()
                if (trimmed.isNotEmpty() || isNote) onCreate(trimmed.ifEmpty { "Untitled" }, mode, Background(pattern, color, "#354052", 24.0))
            }) { Label("Create", color = Neo.accentContrast) }
        }
    }
}

@Composable
private fun PatternPreview(bg: Background) {
    Box(Modifier.fillMaxWidth().height(76.dp).clip(RoundedCornerShape(12.dp)).background(hex(bg.color)).border(1.dp, Neo.border, RoundedCornerShape(12.dp)).drawBehind {
        val step = 18.dp.toPx()
        val ink = Color(0xFF354052)
        when (bg.pattern) {
            "dot-grid" -> { var y = step / 2; while (y < size.height) { var x = step / 2; while (x < size.width) { drawCircle(ink, 1.dp.toPx(), Offset(x, y)); x += step }; y += step } }
            "square-grid", "ruled" -> {
                var y = 0f; while (y < size.height) { drawLine(ink, Offset(0f, y), Offset(size.width, y), 1.dp.toPx()); y += step }
                if (bg.pattern == "square-grid") { var x = 0f; while (x < size.width) { drawLine(ink, Offset(x, 0f), Offset(x, size.height), 1.dp.toPx()); x += step } }
            }
        }
    })
}

@Composable
private fun ChoiceField(legend: String, content: @Composable () -> Unit) {
    Column { Label(legend, 12.sp, Neo.muted, modifier = Modifier.padding(bottom = 7.dp)); content() }
}

@Composable
private fun Segmented(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        for ((value, label) in options) {
            val on = value == selected
            val shape = RoundedCornerShape(Neo.radius)
            var m = Modifier.weight(1f).heightIn(min = 38.dp).clip(shape)
            m = if (on) m.background(Neo.mix(Neo.accent, Neo.surface, 0.18f)).insetShadow(Neo.inset).border(1.dp, Neo.accent, shape)
            else m.background(Neo.surface).border(1.dp, Neo.border, shape)
            Box(m.clickable { onSelect(value) }.padding(7.dp), contentAlignment = Alignment.Center) { Label(label) }
        }
    }
}

@Composable
/** A centred modal; [top] pins it near the top so the keyboard can't cover it. */
internal fun NeoDialog(onDismiss: () -> Unit, top: Boolean = false, content: @Composable () -> Unit) {
    val modals = LocalModalCount.current
    androidx.compose.runtime.DisposableEffect(Unit) {
        modals.value++
        onDispose { modals.value-- }
    }
    Dialog(onDismiss, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        // Our overlay supplies the web's rgba(2,4,10,.68) scrim; drop the platform's extra dim.
        (androidx.compose.ui.platform.LocalView.current.parent as? androidx.compose.ui.window.DialogWindowProvider)?.window?.setDimAmount(0f)
        Box(Modifier.fillMaxSize().background(Color(2, 4, 10, (0.68f * 255).roundToInt()))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
            contentAlignment = if (top) Alignment.TopCenter else Alignment.Center) {
            Column(
                Modifier.padding(top = if (top) 96.dp else 0.dp).width(560.dp).panel().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {}.padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) { content() }
        }
    }
}

@Composable
internal fun DialogHeader(eyebrow: String, title: String, onClose: () -> Unit) {
    Column {
        Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), verticalAlignment = Alignment.Top) {
            Column(Modifier.weight(1f)) {
                Label(eyebrow.uppercase(), 10.sp, Neo.accent, FontWeight.ExtraBold, spacing = 0.12.em, modifier = Modifier.padding(bottom = 3.dp))
                Label(title, 19.sp, weight = FontWeight.Bold)
            }
            IconButton(Lucide.X, 16, onClick = onClose)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Neo.border))
    }
}

@Composable
private fun NeoTextField(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().well().padding(horizontal = 10.dp), contentAlignment = Alignment.CenterStart) {
        BasicTextField(value, onChange, singleLine = true, textStyle = TextStyle(color = Neo.text, fontSize = 14.sp, fontFamily = AuroraFont),
            cursorBrush = SolidColor(Neo.accent), modifier = Modifier.fillMaxWidth())
    }
}

@Composable
private fun SettingsDialog(state: AppState, onDismiss: () -> Unit) {
    var url by remember { mutableStateOf(state.settings.serverUrl) }
    NeoDialog(onDismiss) {
        DialogHeader("Preferences", "Settings", onDismiss)
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Label("Server address", 12.sp, Neo.muted)
            NeoTextField(url, { url = it }, Modifier.heightIn(min = 42.dp))
        }
        Row { Label("Device ID", 13.sp, Neo.muted, modifier = Modifier.width(90.dp)); Label(state.settings.deviceId, 13.sp) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End)) {
            NeoButton(fill = Color.Transparent, shadow = false, onClick = onDismiss) { Label("Cancel") }
            NeoButton(fill = Neo.accent, onClick = { state.settings.serverUrl = url; onDismiss(); state.restart() }) { Label("Save", color = Neo.accentContrast) }
        }
    }
}

// ---- Top bar ---------------------------------------------------------------

@Composable
private fun TopBar(state: AppState, onSettings: () -> Unit) {
    val status by state.sync.status.collectAsState()
    Row(
        Modifier.fillMaxWidth().heightIn(min = 60.dp).panel(Neo.shell, fill = Neo.surface.copy(alpha = 0.68f)).padding(shellGap),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(shellGap),
    ) {
        val note = state.openNote
        Box(Modifier.weight(1f).padding(start = 10.dp)) {
            if (note != null) Label(note.title.ifBlank { "Untitled" }, 16.sp, weight = FontWeight.SemiBold)
            else Label("No note selected", 15.sp, weight = FontWeight.SemiBold)
        }
        state.error?.let { Label(it, 12.sp, Neo.danger, modifier = Modifier.weight(1f, fill = false).clickable { state.error = null }) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // .sync-pill
            Row(Modifier.clip(CircleShape).background(Neo.surface).border(1.dp, Neo.border, CircleShape).padding(horizontal = 10.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                LucideIcon(if (status.connected) Lucide.Wifi else Lucide.WifiOff, 13, Neo.muted)
                val dot = when { !status.connected -> Neo.danger; status.pending == 0 -> Neo.success; else -> Neo.accent }
                Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
                Label(if (status.pending > 0) "${status.pending} queued" else if (status.connected) "open" else "closed", 12.sp, Neo.muted)
            }
            IconButton(Lucide.Calculator, 16) {}
            note?.let { Label(modeLabel(it.canvasMode), 11.sp, Neo.muted) }
        }
        // button.ghost keeps its hairline border.
        Box(Modifier.size(42.dp, 34.dp).clip(RoundedCornerShape(Neo.radius)).border(1.dp, Neo.border, RoundedCornerShape(Neo.radius)).clickable(onClick = onSettings),
            contentAlignment = Alignment.Center) { LucideIcon(Lucide.Settings, 16) }
        IconButton(Lucide.RefreshCw, 16) { state.restart() }
    }
}

private fun modeLabel(mode: String) = when (mode) {
    "paged" -> "Paged"; "fixed-width" -> "Fixed width"; "fixed-height" -> "Fixed height"; else -> "Infinite"
}

private fun hex(value: String) = Color(android.graphics.Color.parseColor(value))

// ---- Canvas area -----------------------------------------------------------

private data class ToolSpec(val tool: Tool, val icon: ImageVector, val label: String)

private val toolSpecs = listOf(
    ToolSpec(Tool.Select, Lucide.MousePointer2, "Select"),
    ToolSpec(Tool.Lasso, Lucide.LassoSelect, "Lasso select"),
    ToolSpec(Tool.Pan, Lucide.Hand, "Pan"),
    ToolSpec(Tool.Pen, Lucide.Pen, "Pen"),
    ToolSpec(Tool.Highlighter, Lucide.Highlighter, "Highlighter"),
    ToolSpec(Tool.Eraser, Lucide.Eraser, "Erase stroke"),
    ToolSpec(Tool.Line, Lucide.Slash, "Line"),
    ToolSpec(Tool.Rectangle, Lucide.Square, "Rectangle"),
    ToolSpec(Tool.Ellipse, Lucide.Circle, "Ellipse"),
    ToolSpec(Tool.Arrow, Lucide.ArrowUpRight, "Arrow"),
    ToolSpec(Tool.Matrix, Lucide.Brackets, "Matrix brackets"),
)

@Composable
private fun CanvasArea(state: AppState, modifier: Modifier) {
    var tool by remember { mutableStateOf(Tool.Pen) }
    var view by remember { mutableStateOf<CanvasView?>(null) }
    val palette = state.account?.drawingPalette ?: listOf("#000000")
    val color = state.penColor ?: palette.first()

    Box(modifier.panel(Neo.shell, fill = Neo.surfaceSunken)) {
        AndroidView(
            factory = { context -> CanvasView(context).also { view = it; state.attach(it) } },
            modifier = Modifier.fillMaxSize(),
            update = { v -> v.tool = tool; v.penColor = color },
        )
        if (state.openNoteId == null) {
            Label("Select or create a note in the sidebar.", color = Neo.muted, modifier = Modifier.align(Alignment.Center))
            return@Box
        }
        Toolbar(state, tool, onTool = { tool = it }, onPaste = { view?.paste() }, Modifier.align(Alignment.TopCenter).padding(top = 12.dp))
        if (tool == Tool.Pen) PenPalette(palette, color, onColor = { state.penColor = it }, Modifier.align(Alignment.TopStart).padding(start = 12.dp, top = 82.dp))
        val note = state.openNote
        if (note?.canvasMode == "paged" && !state.importedPdf && state.selectionCount == 0) {
            Row(
                Modifier.align(Alignment.BottomCenter).padding(bottom = 22.dp).heightIn(min = 38.dp)
                    .panel(radius = 999.dp, fill = Neo.surfaceRaised).clickable { state.addPageBelow() }.padding(horizontal = 14.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LucideIcon(Lucide.Plus, 16)
                Label("Add page below page ${state.currentPage + 1}")
            }
        }
        // .canvas-statusbar zoom readout
        Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 24.dp).offset(y = 2.dp)
            .clip(CircleShape).background(Neo.surface.copy(alpha = 0.9f)).border(1.dp, Neo.border, CircleShape).padding(horizontal = 12.dp, vertical = 3.dp)) {
            Label("${(state.zoom * 100).roundToInt()}%", 10.sp, Neo.muted)
        }
        if (note?.canvasMode == "paged" || note?.canvasMode == "fixed-width") {
            val locked = state.lockX
            Box(Modifier.align(Alignment.BottomStart).padding(start = 8.dp, bottom = 2.dp).size(24.dp)
                .panel(radius = 12.dp, fill = Neo.surface.copy(alpha = 0.92f)).clickable { state.lockX = !locked },
                contentAlignment = Alignment.Center) { LucideIcon(if (locked) Lucide.Lock else Lucide.Unlock, 12, if (locked) Neo.accent else Neo.muted) }
        }
        SelectionBar(state, view)
    }
}

@Composable
private fun Toolbar(state: AppState, tool: Tool, onTool: (Tool) -> Unit, onPaste: () -> Unit, modifier: Modifier) {
    Row(
        modifier.panel(radius = 13.dp, fill = Neo.surface.copy(alpha = 0.92f)).padding(10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (spec in toolSpecs) ToolButton(spec.icon, active = spec.tool == tool) { onTool(spec.tool) }
        }
        // Undo, redo and paste only appear while they can do something.
        if (state.canUndo || state.canRedo || state.canPaste) {
            Box(Modifier.padding(horizontal = 4.dp).size(1.dp, 18.dp).background(Color.White.copy(alpha = 0.16f)))
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (state.canUndo) ToolButton(Lucide.Undo2) { state.undo() }
                if (state.canRedo) ToolButton(Lucide.Redo2) { state.redo() }
                if (state.canPaste) ToolButton(Lucide.ClipboardPaste, onClick = onPaste)
            }
        }
    }
}

/** .canvas-toolbar button: 52x44, radius 7, surface; active is accent with dark ink. */
@Composable
private fun ToolButton(icon: ImageVector, active: Boolean = false, onClick: () -> Unit) {
    // Toolbar buttons keep the base button's raised shadow; only their border is removed.
    Box(
        Modifier.size(52.dp, 44.dp)
            .panel(Neo.outset, 7.dp, if (active) Neo.accent else Neo.surface, Color.Transparent).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { LucideIcon(icon, 16, if (active) Neo.toolActiveInk else Neo.text) }
}

/** The pen tool's vertical palette (.drawing-properties-panel[data-tool="pen"]). */
@Composable
private fun PenPalette(colors: List<String>, selected: String, onColor: (String) -> Unit, modifier: Modifier) {
    Column(modifier.width(50.dp).panel().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(28.dp, 26.dp).panel(radius = Neo.radius), contentAlignment = Alignment.Center) { LucideIcon(Lucide.Trash2, 13, Neo.muted) }
        for (c in colors) {
            val on = c.equals(selected, ignoreCase = true)
            // outline: 2px accent, offset 3px — drawn outside the swatch without changing layout.
            Box(Modifier.size(32.dp).drawBehind {
                if (on) drawCircle(Neo.accent, radius = size.minDimension / 2 + 4.dp.toPx(), style = Stroke(2.dp.toPx()))
            }) {
                Box(Modifier.fillMaxSize().clip(CircleShape).background(hex(c)).insetShadow(listOf(BoxShadow(0, 1, 3, Color.Black.copy(alpha = 0.45f))), 16.dp)
                    .border(2.dp, Neo.mix(Neo.border, Color.White, 0.91f).copy(alpha = 0.16f), CircleShape).clickable { onColor(c) })
            }
        }
        Box(Modifier.size(32.dp).clip(CircleShape).background(Neo.surfaceSunken).dashedBorder(Neo.border.copy(alpha = 0.2f), 16.dp), contentAlignment = Alignment.Center) {
            LucideIcon(Lucide.Plus, 17, Neo.muted)
        }
    }
}

/** The floating .selection-actions bar above (or below) the selection. */
@Composable
private fun SelectionBar(state: AppState, view: CanvasView?) {
    @Suppress("UNUSED_VARIABLE") val tick = state.chromeTick
    val rect = view?.selectionScreenRect() ?: return
    val density = LocalDensity.current
    var barSize by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    val gap = with(density) { 12.dp.toPx() }
    val minTop = with(density) { 96.dp.toPx() }
    val up = rect.top - gap - barSize.height >= minTop
    val x = (rect.centerX() - barSize.width / 2f).coerceIn(8f, (view.width - barSize.width - 8f).coerceAtLeast(8f))
    val y = if (up) rect.top - gap - barSize.height else (rect.bottom + gap).coerceAtMost(view.height - barSize.height - 56f)
    Row(
        Modifier.offset { IntOffset(x.roundToInt(), y.roundToInt()) }.onGloballyPositioned { barSize = it.size }
            .boxShadow(Neo.floating, 999.dp).clip(CircleShape).background(Neo.surface.copy(alpha = 0.94f)).border(1.dp, Neo.border, CircleShape).padding(4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Label("${state.selectionCount} selected", 12.sp, Neo.muted, modifier = Modifier.padding(start = 10.dp, end = 8.dp))
        Divider()
        SelectionAction(Lucide.Copy) { view.copySelection(false); state.refreshChrome() }
        SelectionAction(Lucide.Scissors) { view.copySelection(true); state.refreshChrome() }
        SelectionAction(Lucide.CopyPlus) { view.duplicateSelection() }
        Divider()
        SelectionAction(Lucide.BringToFront) { view.reorderSelection(true) }
        SelectionAction(Lucide.SendToBack) { view.reorderSelection(false) }
        Divider()
        SelectionAction(Lucide.Trash2, Neo.danger) { view.deleteSelection() }
    }
}

@Composable
private fun Divider() = Box(Modifier.padding(horizontal = 3.dp).size(1.dp, 18.dp).background(Neo.border))

@Composable
private fun SelectionAction(icon: ImageVector, tint: Color = Neo.text, onClick: () -> Unit) {
    Box(Modifier.size(40.dp).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) { LucideIcon(icon, 15, tint) }
}

