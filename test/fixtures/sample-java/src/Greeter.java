package demo;

/** A greeter with a personality. */
public class Greeter {

  private final String prefix;

  public Greeter(String prefix) {
    this.prefix = prefix;
  }

  public String greet(String name) {
    return prefix + name;
  }

  String casualGreet(String name) {
    return "hi " + name + Helper.helperValue();
  }
}
