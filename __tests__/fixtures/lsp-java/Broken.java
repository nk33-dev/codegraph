// Deliberate type error for the get_diagnostics assertion (jdt.ls reports a type mismatch).
public class Broken {
    public int brokenValue() {
        return "not a number";
    }
}
