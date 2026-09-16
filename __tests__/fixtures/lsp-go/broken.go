package main

// BrokenType keeps a deliberate type error for the get_diagnostics assertion (gopls reports cannot use ... as int).
func BrokenType() int {
	return "not a number"
}
