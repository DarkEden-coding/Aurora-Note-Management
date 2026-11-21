// The top bar's calculator: a draggable popover with the web's keypad and arithmetic grammar
// (apps/web/src/features/calculator).
package app.aurora.notes.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.pow
import kotlin.math.roundToInt

private val keys = listOf("(", ")", "%", "/", "7", "8", "9", "*", "4", "5", "6", "-", "1", "2", "3", "+", "0", ".", "^", "=")

/** The floating calculator, placed below the top bar's right end and dragged by its header. */
@Composable
internal fun CalculatorPopover(onClose: () -> Unit, modifier: Modifier = Modifier) {
    var expression by remember { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }
    var drag by remember { mutableStateOf(Offset.Zero) }

    fun calculate() {
        val result = runCatching { evaluateExpression(expression) }.getOrNull()
        if (result == null) error = true else { expression = formatNumber(result); error = false }
    }
    fun append(key: String) {
        expression = if (error) key else expression + key
        error = false
    }

    Column(
        modifier.offset { IntOffset(drag.x.roundToInt(), drag.y.roundToInt()) }.width(224.dp)
            .panel(Neo.floating + Neo.outset, Neo.radius, Neo.surface).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            Modifier.fillMaxWidth().pointerInput(Unit) { detectDragGestures { change, delta -> change.consume(); drag += delta } },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Label("Calculator", 13.sp, weight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
            IconButton(Lucide.X, 15, onClick = onClose)
        }
        Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).well(10.dp, border = if (error) Neo.danger else Neo.border).padding(horizontal = 10.dp),
            contentAlignment = Alignment.CenterEnd) {
            BasicTextField(
                expression, { expression = it; error = false }, singleLine = true,
                textStyle = TextStyle(color = Neo.text, fontSize = 18.sp, fontFamily = AuroraFont, textAlign = TextAlign.End),
                cursorBrush = SolidColor(Neo.accent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { calculate() }),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (error) Label("Invalid expression", 11.sp, Neo.danger)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CalcKey("Clear", Modifier.weight(3f)) { expression = ""; error = false }
            CalcKey(null, Modifier.weight(1f)) { expression = expression.dropLast(1); error = false }
        }
        for (row in keys.chunked(4)) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (key in row) CalcKey(key, Modifier.weight(1f), primary = key == "=") { if (key == "=") calculate() else append(key) }
        }
    }
}

/** A keypad button; a null label is the backspace key. */
@Composable
private fun CalcKey(label: String?, modifier: Modifier, primary: Boolean = false, onClick: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier.height(38.dp).clip(shape).background(if (primary) Neo.accent else Neo.surfaceRaised)
            .border(1.dp, Neo.border, shape).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        if (label == null) LucideIcon(Lucide.Delete, 16)
        else Label(label, 14.sp, if (primary) Neo.accentContrast else Neo.text, if (primary) FontWeight.Bold else FontWeight.Normal)
    }
}

/** Shows whole results without a trailing ".0", like JavaScript's String(number). */
private fun formatNumber(value: Double): String =
    if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()

/** Evaluates + - * / % ^ and parentheses; throws on malformed input, division by zero or a non-finite result. */
internal fun evaluateExpression(source: String): Double {
    val parser = ExpressionParser(source)
    val result = parser.expression()
    parser.skipWhitespace()
    require(parser.atEnd()) { "Unexpected input" }
    require(result.isFinite()) { "Result is not finite" }
    return result
}

private class ExpressionParser(private val source: String) {
    private var position = 0

    fun expression(): Double {
        var value = term()
        while (true) {
            value = when {
                consume('+') -> value + term()
                consume('-') -> value - term()
                else -> return value
            }
        }
    }

    private fun term(): Double {
        var value = unary()
        while (true) {
            value = when {
                consume('*') -> value * unary()
                consume('/') -> unary().let { require(it != 0.0) { "Cannot divide by zero" }; value / it }
                consume('%') -> unary().let { require(it != 0.0) { "Cannot divide by zero" }; value % it }
                else -> return value
            }
        }
    }

    private fun unary(): Double = when {
        consume('+') -> unary()
        consume('-') -> -unary()
        else -> power()
    }

    private fun power(): Double {
        val base = primary()
        return if (consume('^')) base.pow(unary()) else base
    }

    private fun primary(): Double {
        if (consume('(')) {
            val value = expression()
            require(consume(')')) { "Expected closing parenthesis" }
            return value
        }
        return number()
    }

    private fun number(): Double {
        skipWhitespace()
        val start = position
        var digits = 0
        while (position < source.length && source[position].isDigit()) { position++; digits++ }
        if (position < source.length && source[position] == '.') {
            position++
            while (position < source.length && source[position].isDigit()) { position++; digits++ }
        }
        require(digits > 0) { "Expected a number" }
        return source.substring(start, position).toDouble()
    }

    private fun consume(character: Char): Boolean {
        skipWhitespace()
        if (position >= source.length || source[position] != character) return false
        position++
        return true
    }

    fun skipWhitespace() {
        while (position < source.length && source[position].isWhitespace()) position++
    }

    fun atEnd() = position >= source.length
}
