; Hover %total, add, @sum, and %left.
; Use F12 on @sum below, F2 on %total, or Find All References.
; While typing a call to @sum, ( and , trigger signature help.
; Hover icmp below for placeholder syntax and all comparison conditions.
; Fold entry, "left wins", and done independently; their references share a color.

@message = private constant [9 x i8] c"sum: %d\0A\00"
declare i32 @printf(ptr, ...)

define i32 @sum(i32 %left, i32 %right) {
entry:
  %total = add i32 %left, %right
  ret i32 %total
}

define i32 @maximum(i32 %left, i32 %right) {
entry:
  %larger = icmp sgt i32 %left, %right
  br i1 %larger, label %"left wins", label %done
"left wins":
  br label %done
done:
  %value = phi i32 [ %left, %"left wins" ], [ %right, %entry ]
  ret i32 %value
}

define i32 @main() {
entry:
  %answer = call i32 @sum(i32 20, i32 22)
  %printed = call i32 (ptr, ...) @printf(ptr @message, i32 %answer)
  ret i32 0
}
